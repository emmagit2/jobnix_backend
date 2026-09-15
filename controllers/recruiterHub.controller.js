// controllers/recruiterHub.controller.js
//
// The email-scoped, cross-job dashboard (/recruiter-hub). Two halves:
//
//   1. Auth + jobs/applications — mirrors applications.controller.js's
//      recruiter-view functions (getRecruiterView, requestRecruiterCode,
//      verifyRecruiterCode, getRecruiterApplications), just keyed by
//      recruiter_email across every 'platform' job instead of one
//      recruiter_view_token. Same recruiter_access_codes PATTERN (plaintext
//      code, 10min expiry) but its own table (recruiter_hub_codes), since
//      recruiter_access_codes is keyed by job_id and the hub has none.
//
//   2. Messaging — mirrors recruiterViewMessages.controller.js exactly,
//      reusing the same recruiter_guests identity (keyed by email,
//      merged_user_id = "graduated to a real account").
//
// Jobs are only ever matched on (recruiter_email = email AND
// apply_method = 'platform') — same rule getOrCreateRecruiterLink already
// enforces, since email-apply jobs never populate `applications` the way
// one-click jobs do.

import { randomUUID, randomInt } from "crypto";
import { supabase } from "../config/supabase.js";
import messagingAdminDB, { syncUserToMessagingDB } from "../lib/messagingAdminDB.js";
import { sendEmail } from "../lib/email.js";
import { signHubAccessToken, verifyHubAccessToken } from "../lib/recruiterHubAuth.js";
import { fetchJobsWithCounts } from "../lib/recruiterHubQueries.js";
// Add this alongside recruiterAccessCodeEmail in lib/emailTemplates.js:
//   export const recruiterHubAccessCodeEmail = ({ code }) => ({
//     subject: "Your Jobnix recruiter dashboard code",
//     html: `<p>Your one-time code is <b>${code}</b>. It expires in 10 minutes.</p>`,
//   });
import { recruiterHubAccessCodeEmail } from "../lib/emailTemplates.js";

const CODE_TTL_MINUTES = 10;

// Same dedupe/upsert rule as findOrCreateGuestForEmail in
// recruiterViewMessages.controller.js — kept local so this file has no
// import-order dependency on that one.
async function findOrCreateGuestForEmail(email) {
  const normalizedEmail = email.trim().toLowerCase();
  const { data: existing } = await supabase
    .from("recruiter_guests")
    .select("*")
    .eq("email", normalizedEmail)
    .maybeSingle();
  if (existing) return existing;

  const { data: created, error } = await supabase
    .from("recruiter_guests")
    .insert({ id: randomUUID(), email: normalizedEmail, name: normalizedEmail, company: null })
    .select("*")
    .single();
  if (error) throw error;
  return created;
}

const messagingIdentityFor = (guest) => guest.merged_user_id ?? guest.id;

// =============================
// POST /recruiter-hub/request-code
// body: { email }
// Always "succeeds" regardless of whether this email owns any jobs, so the
// endpoint can't be used to enumerate which addresses are recruiters.
// =============================
export const requestHubCode = async (req, res) => {
  const email = (req.body.email || "").trim().toLowerCase();
  if (!email || !email.includes("@")) {
    return res.status(400).json({ message: "A valid email is required." });
  }

  const code = String(randomInt(100000, 999999));
  const expiresAt = new Date(Date.now() + CODE_TTL_MINUTES * 60_000).toISOString();

  const { error } = await supabase.from("recruiter_hub_codes").insert({ email, code, expires_at: expiresAt });
  if (error) return res.status(500).json({ message: error.message });

  const { subject, html } = recruiterHubAccessCodeEmail({ code });
  await sendEmail({ to: email, subject, html });

  return res.json({ message: "Code sent." });
};

// =============================
// POST /recruiter-hub/verify-code
// body: { email, code }
// =============================
export const verifyHubCode = async (req, res) => {
  const email = (req.body.email || "").trim().toLowerCase();
  const code = req.body.code;
  if (!email || !code) return res.status(400).json({ message: "email and code are required." });

  const { data: codeRow, error: codeErr } = await supabase
    .from("recruiter_hub_codes")
    .select("*")
    .eq("email", email)
    .eq("code", code)
    .is("used_at", null)
    .gt("expires_at", new Date().toISOString())
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (codeErr) return res.status(500).json({ message: codeErr.message });
  if (!codeRow) return res.status(400).json({ message: "Invalid or expired code." });

  await supabase.from("recruiter_hub_codes").update({ used_at: new Date().toISOString() }).eq("id", codeRow.id);

  try {
    const jobs = await fetchJobsWithCounts(email);
    const access_token = signHubAccessToken(email);
    return res.json({ data: { access_token, recruiter_email: email, jobs } });
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
};

// =============================
// GET /recruiter-hub/jobs
// =============================
export const listHubJobs = async (req, res) => {
  const payload = verifyHubAccessToken(req);
  if (!payload) return res.status(401).json({ message: "Access token expired — request a new code." });
  try {
    return res.json({ data: await fetchJobsWithCounts(payload.email) });
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
};

// =============================
// GET /recruiter-hub/jobs/:jobId/applications
// Same select shape as getRecruiterApplications — applicant_id is
// selected directly (not just nested under profiles) since messaging
// needs the raw id to start a conversation.
// =============================
export const listHubApplications = async (req, res) => {
  const payload = verifyHubAccessToken(req);
  if (!payload) return res.status(401).json({ message: "Access token expired — request a new code." });

  const { jobId } = req.params;

  const { data: job, error: jobErr } = await supabase
    .from("jobs")
    .select("id, recruiter_email, apply_method")
    .eq("id", jobId)
    .maybeSingle();
  if (jobErr) return res.status(500).json({ message: jobErr.message });
  if (!job || job.recruiter_email !== payload.email || job.apply_method !== "platform") {
    return res.status(403).json({ message: "Not authorized for this job." });
  }

  const { data: applications, error } = await supabase
    .from("applications")
    .select(`
      id, applicant_id, applied_at,
      profiles:applicant_id (
        id, email,
        user_profiles ( full_name, avatar_url, cv_url, username )
      )
    `)
    .eq("job_id", jobId)
    .order("applied_at", { ascending: false });
  if (error) return res.status(500).json({ message: error.message });

  return res.json({ data: applications });
};

// =============================
// GET /recruiter-hub/conversations
// =============================
export const listHubConversations = async (req, res) => {
  const payload = verifyHubAccessToken(req);
  if (!payload) return res.status(401).json({ message: "Access token expired — request a new code." });

  const { data: guest } = await supabase
    .from("recruiter_guests")
    .select("*")
    .eq("email", payload.email)
    .maybeSingle();
  if (!guest) return res.json({ data: [] });

  const recruiterUserId = messagingIdentityFor(guest);

  const { data, error } = await messagingAdminDB
    .from("conversations")
    .select(`
      id, last_message_at, job_id, participant_one, participant_two,
      p1:users!conversations_participant_one_fkey(id, display_name, avatar_url),
      p2:users!conversations_participant_two_fkey(id, display_name, avatar_url)
    `)
    .or(`participant_one.eq.${recruiterUserId},participant_two.eq.${recruiterUserId}`)
    .order("last_message_at", { ascending: false });
  if (error) return res.status(500).json({ message: error.message });

  const jobIds = [...new Set(data.map((c) => c.job_id).filter(Boolean))];
  let titleById = {};
  if (jobIds.length) {
    const { data: jobs } = await supabase.from("jobs").select("id, title").in("id", jobIds);
    titleById = Object.fromEntries((jobs || []).map((j) => [j.id, j.title]));
  }

  const conversations = data.map((c) => ({
    id: c.id,
    last_message_at: c.last_message_at,
    otherUser: c.participant_one === recruiterUserId ? c.p2 : c.p1,
    job_title: titleById[c.job_id] || "General",
  }));

  return res.json({ data: conversations });
};

// GET /recruiter-hub/conversations/:conversationId/thread
export const getHubThread = async (req, res) => {
  const payload = verifyHubAccessToken(req);
  if (!payload) return res.status(401).json({ message: "Access token expired — request a new code." });

  const { data: guest } = await supabase.from("recruiter_guests").select("*").eq("email", payload.email).maybeSingle();
  if (!guest) return res.status(404).json({ message: "Conversation not found" });

  const recruiterUserId = messagingIdentityFor(guest);
  const { conversationId } = req.params;

  const { data: convo, error: convoErr } = await messagingAdminDB
    .from("conversations")
    .select("id, participant_one, participant_two")
    .eq("id", conversationId)
    .maybeSingle();
  if (convoErr) return res.status(500).json({ message: convoErr.message });
  if (!convo) return res.status(404).json({ message: "Conversation not found" });
  if (convo.participant_one !== recruiterUserId && convo.participant_two !== recruiterUserId) {
    return res.status(403).json({ message: "Not a participant in this conversation" });
  }

  const { data: messages, error: msgErr } = await messagingAdminDB
    .from("messages")
    .select("*")
    .eq("conversation_id", conversationId)
    .order("created_at", { ascending: true });
  if (msgErr) return res.status(500).json({ message: msgErr.message });

  await messagingAdminDB
    .from("messages")
    .update({ read_at: new Date().toISOString() })
    .eq("conversation_id", conversationId)
    .neq("sender_id", recruiterUserId)
    .is("read_at", null);

  return res.json({ data: messages });
};

// POST /recruiter-hub/conversations/:conversationId/reply
export const replyHub = async (req, res) => {
  const payload = verifyHubAccessToken(req);
  if (!payload) return res.status(401).json({ message: "Access token expired — request a new code." });

  const { content } = req.body;
  if (!content?.trim()) return res.status(400).json({ message: "content is required" });

  const { data: guest } = await supabase.from("recruiter_guests").select("*").eq("email", payload.email).maybeSingle();
  if (!guest) return res.status(404).json({ message: "Conversation not found" });

  const recruiterUserId = messagingIdentityFor(guest);
  const { conversationId } = req.params;

  const { data: convo, error: convoErr } = await messagingAdminDB
    .from("conversations")
    .select("id, participant_one, participant_two")
    .eq("id", conversationId)
    .maybeSingle();
  if (convoErr) return res.status(500).json({ message: convoErr.message });
  if (!convo) return res.status(404).json({ message: "Conversation not found" });
  if (convo.participant_one !== recruiterUserId && convo.participant_two !== recruiterUserId) {
    return res.status(403).json({ message: "Not a participant in this conversation" });
  }

  const { error: msgErr } = await messagingAdminDB
    .from("messages")
    .insert({ conversation_id: conversationId, sender_id: recruiterUserId, content: content.trim() });
  if (msgErr) return res.status(500).json({ message: msgErr.message });

  await messagingAdminDB.from("conversations").update({ last_message_at: new Date().toISOString() }).eq("id", conversationId);

  return res.json({ ok: true });
};

// =============================
// POST /recruiter-hub/conversations/start
// body: { candidateId, jobId, content }
// =============================
export const startHubConversation = async (req, res) => {
  const payload = verifyHubAccessToken(req);
  if (!payload) return res.status(401).json({ message: "Access token expired — request a new code." });

  const { candidateId, jobId, content } = req.body;
  if (!candidateId || !content?.trim()) {
    return res.status(400).json({ message: "candidateId and content are required" });
  }

  if (jobId) {
    const { data: job } = await supabase.from("jobs").select("id, recruiter_email, apply_method").eq("id", jobId).maybeSingle();
    if (!job || job.recruiter_email !== payload.email || job.apply_method !== "platform") {
      return res.status(403).json({ message: "Not authorized for this job." });
    }
  }

  let guest;
  try {
    guest = await findOrCreateGuestForEmail(payload.email);
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }

  const recruiterUserId = messagingIdentityFor(guest);

  await syncUserToMessagingDB({
    id: recruiterUserId,
    role: guest.merged_user_id ? "recruiter" : "guest_recruiter",
    name: guest.name,
    email: guest.email,
    org_name: guest.company ?? null,
  });

  const { data: existing, error: findErr } = await messagingAdminDB
    .from("conversations")
    .select("id")
    .or(
      `and(participant_one.eq.${recruiterUserId},participant_two.eq.${candidateId}),` +
        `and(participant_one.eq.${candidateId},participant_two.eq.${recruiterUserId})`
    )
    .maybeSingle();
  if (findErr) return res.status(500).json({ message: findErr.message });

  let conversationId = existing?.id;
  if (!conversationId) {
    const { data: created, error: convoErr } = await messagingAdminDB
      .from("conversations")
      .insert({ participant_one: recruiterUserId, participant_two: candidateId, job_id: jobId || null })
      .select("id")
      .single();
    if (convoErr) return res.status(500).json({ message: convoErr.message });
    conversationId = created.id;
  }

  const { error: msgErr } = await messagingAdminDB
    .from("messages")
    .insert({ conversation_id: conversationId, sender_id: recruiterUserId, content: content.trim() });
  if (msgErr) return res.status(500).json({ message: msgErr.message });

  await messagingAdminDB.from("conversations").update({ last_message_at: new Date().toISOString() }).eq("id", conversationId);

  return res.json({ ok: true, conversationId });
};