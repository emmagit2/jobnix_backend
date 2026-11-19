// services/loginNudgeService.js
//
// Notices owners who have not logged in to JobNix for a while and tells them to
// log in and post a job.
//   1) getLoginNudge(business): used by the controller when the owner messages the bot.
//   2) runInactiveNudges(): run once a day (cron) to message inactive owners on its own.
import twilio from "twilio";
import { supabase } from "../config/supabase.js";
import { sendText } from "./whatsappService.js";

const INACTIVE_DAYS = Number(process.env.NUDGE_INACTIVE_DAYS || 14);
const COOLDOWN_DAYS = Number(process.env.NUDGE_COOLDOWN_DAYS || 7);
const FRONTEND_URL = (process.env.FRONTEND_URL || "http://localhost:5173").replace(/\/+$/, "");
const DASHBOARD_LINK = `${FRONTEND_URL}${process.env.DASH_PATH_POST_JOB || "/business/dashboard"}`;
const DAY_MS = 86400000;

// ── Helpers ────────────────────────────────────────────────────────────────
async function daysSinceLogin(businessId) {
  // ASSUMPTION: business_profiles.id equals the auth user id
  const { data, error } = await supabase.auth.admin.getUserById(businessId);
  if (error || !data?.user?.last_sign_in_at) return null;
  return Math.floor((Date.now() - new Date(data.user.last_sign_in_at).getTime()) / DAY_MS);
}

async function recentlyNudged(businessId) {
  const { data } = await supabase
    .from("whatsapp_nudges")
    .select("last_nudged_at")
    .eq("business_id", businessId)
    .maybeSingle();
  if (!data) return false;
  return Date.now() - new Date(data.last_nudged_at).getTime() < COOLDOWN_DAYS * DAY_MS;
}

const markNudged = (businessId) =>
  supabase.from("whatsapp_nudges").upsert({ business_id: businessId, last_nudged_at: new Date().toISOString() });

async function liveJobCount(businessId) {
  const { data } = await supabase
    .from("jobs")
    .select("expires_at, deadline")
    .eq("submitted_by_business_id", businessId)
    .eq("status", "approved");
  const now = Date.now();
  const today = new Date(new Date().toDateString()).getTime();
  return (data || []).filter((j) => {
    if (j.expires_at) return new Date(j.expires_at).getTime() >= now;
    if (j.deadline) return new Date(j.deadline).getTime() >= today;
    return true;
  }).length;
}

function buildText(name, days, live) {
  const jobsLine =
    live === 0
      ? "You don't have a live job right now, so workers can't find you."
      : `You have ${live} live job${live > 1 ? "s" : ""}.`;
  return (
    `Hi ${name || "there"}, you haven't logged in to JobNix for ${days} days. ${jobsLine}\n\n` +
    `Log in here to check applicants and post a job:\n${DASHBOARD_LINK}\n\n` +
    'Or reply "post a job" and I\'ll post it for you right here in WhatsApp.'
  );
}

// ── 1) In-chat nudge ───────────────────────────────────────────────────────
/** Returns a nudge text to append to a reply, or null. Marks the business as nudged. */
export async function getLoginNudge(business) {
  try {
    const days = await daysSinceLogin(business.id);
    if (days == null || days < INACTIVE_DAYS) return null;
    if (await recentlyNudged(business.id)) return null;
    const live = await liveJobCount(business.id);
    await markNudged(business.id);
    return buildText(business.business_name, days, live);
  } catch (err) {
    console.error("[loginNudge] getLoginNudge failed:", err.message);
    return null; // never break the normal reply because of a nudge
  }
}

// ── 2) Daily proactive nudge ───────────────────────────────────────────────
const twilioClient =
  process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN
    ? twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN)
    : null;

// WhatsApp only allows free text within 24h of the user's last message.
// Outside that window you must send an APPROVED TEMPLATE. Set TWILIO_NUDGE_CONTENT_SID
// to the template's Content SID (variables: {{1}} = business name, {{2}} = days).
async function sendNudge(digits, name, days, live) {
  const sid = process.env.TWILIO_NUDGE_CONTENT_SID;
  if (sid && twilioClient) {
    return twilioClient.messages.create({
      from: process.env.TWILIO_WHATSAPP_FROM,
      to: `whatsapp:+${digits}`,
      contentSid: sid,
      contentVariables: JSON.stringify({ 1: name || "there", 2: String(days) }),
    });
  }
  return sendText(digits, buildText(name, days, live)); // works only inside the 24h window
}

/** Call once a day. Messages every verified business inactive for INACTIVE_DAYS or more. */
export async function runInactiveNudges() {
  const { data: businesses, error } = await supabase
    .from("business_profiles")
    .select("id, business_name, phone")
    .eq("phone_verified", true)
    .not("phone", "is", null)
    .limit(500);
  if (error) throw error;

  const result = { checked: 0, sent: 0, failed: 0 };
  for (const b of businesses || []) {
    result.checked++;
    try {
      if (await recentlyNudged(b.id)) continue;
      const days = await daysSinceLogin(b.id);
      if (days == null || days < INACTIVE_DAYS) continue;

      const live = await liveJobCount(b.id);
      await sendNudge(String(b.phone).replace(/\D/g, ""), b.business_name, days, live);
      await markNudged(b.id);
      result.sent++;
    } catch (err) {
      result.failed++;
      console.error("[loginNudge] nudge failed for", b.id, err.message);
    }
  }
  return result;
}

/** Express handler: POST /api/internal/nudges/run  with header x-cron-secret: <CRON_SECRET> */
export async function nudgeCronHandler(req, res) {
  // Accepts "Authorization: Bearer <secret>" (like your other cron jobs) or "x-cron-secret: <secret>"
  const raw = req.headers.authorization || req.headers["x-cron-secret"] || "";
  const sent = String(raw).replace(/^Bearer\s+/i, "").trim();
  if (!process.env.CRON_SECRET || sent !== process.env.CRON_SECRET) {
    return res.status(401).json({ success: false });
  }
  try {
    res.json({ success: true, ...(await runInactiveNudges()) });
  } catch (err) {
    console.error("[loginNudge] cron failed:", err);
    res.status(500).json({ success: false });
  }
}