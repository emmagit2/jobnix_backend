// services/postJobLinkService.js
//
// Creates a short-lived link so a business owner can post a job on the website
// from WhatsApp, with optional pre-filled fields. No payment happens in chat.
import crypto from "crypto";
import { supabase } from "../config/supabase.js";

const LINK_TTL_MINUTES = 30;

// Where the post-job page lives on your frontend. Adjust POST_JOB_PATH to your real route.
const FRONTEND_URL = (process.env.FRONTEND_URL || "http://localhost:5173").replace(/\/+$/, "");
const POST_JOB_PATH = process.env.POST_JOB_PATH || "/business/post-job";

const sha256 = (value) => crypto.createHash("sha256").update(value).digest("hex");

// Only these fields can be pre-filled, so the model can't inject anything else.
const PREFILL_LIMITS = { title: 120, location: 120, pay_type: 20, pay_amount: 40, workers_needed: 2 };
const PAY_TYPES = ["Daily", "Weekly", "Monthly", "Per job"];

function cleanPrefill(input = {}) {
  const out = {};
  for (const [key, max] of Object.entries(PREFILL_LIMITS)) {
    const raw = input[key];
    if (raw == null || raw === "") continue;
    const value = String(raw).trim().slice(0, max);
    if (!value) continue;
    if (key === "pay_type") {
      const match = PAY_TYPES.find((p) => p.toLowerCase() === value.toLowerCase());
      if (match) out.pay_type = match;
    } else if (key === "workers_needed") {
      const n = parseInt(value, 10);
      if (n >= 1 && n <= 10) out.workers_needed = n; // matches jobs_workers_needed_check
    } else {
      out[key] = value;
    }
  }
  return out;
}

/** Called by the Gemini tool. Returns the link to send to the owner on WhatsApp. */
export async function createPostJobLink(businessId, prefillInput = {}) {
  const token = crypto.randomBytes(24).toString("base64url");
  const expiresAt = new Date(Date.now() + LINK_TTL_MINUTES * 60 * 1000);

  const { error } = await supabase.from("whatsapp_action_links").insert({
    business_id: businessId,
    token_hash: sha256(token),
    action: "post_job",
    prefill: cleanPrefill(prefillInput),
    expires_at: expiresAt.toISOString(),
  });
  if (error) throw error;

  // URL API: works whether POST_JOB_PATH is "/business/post-job" or already has
  // a query such as "/dashboard?tab=jobs" (adds &wa=... instead of a second "?").
  const url = new URL(POST_JOB_PATH, `${FRONTEND_URL}/`);
  url.searchParams.set("wa", token);

  return {
    link: url.toString(),
    expiresInMinutes: LINK_TTL_MINUTES,
  };
}

/**
 * Express handler: POST /api/whatsapp/post-job-link/redeem   body: { token }
 * Mount it behind your normal business-auth middleware (the one that sets req.businessId).
 * The frontend calls this when the post-job page opens with ?wa=<token>.
 */
export async function redeemPostJobLink(req, res) {
  const token = String(req.body?.token || "");
  if (!token) return res.status(400).json({ success: false, message: "token is required" });

  const { data, error } = await supabase
    .from("whatsapp_action_links")
    .select("business_id, prefill, expires_at, action")
    .eq("token_hash", sha256(token))
    .maybeSingle();

  if (error) return res.status(500).json({ success: false, message: "Could not check this link." });
  if (!data || data.action !== "post_job") {
    return res.status(404).json({ success: false, message: "This link isn't valid." });
  }
  if (new Date(data.expires_at) < new Date()) {
    return res.status(410).json({ success: false, message: "This link has expired. Ask the WhatsApp bot for a new one." });
  }
  if (data.business_id !== req.businessId) {
    return res
      .status(403)
      .json({ success: false, message: "This link belongs to a different business account. Log in with the right account." });
  }

  res.json({ success: true, prefill: data.prefill || {} });
}