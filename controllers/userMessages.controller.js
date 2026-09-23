// controllers/userMessages.controller.js
//
// Messaging for ANY logged-in user (jobseeker, business, corporate) —
// the "log in and see your inbox" path. This is intentionally separate
// from recruiterViewMessages.controller.js (the LINK + CODE, no-login
// guest flow) because identity works differently here:
//
//   recruiterViewMessages.controller.js -> recruiter_guests row, keyed by
//                                           verified email (no account)
//   userMessages.controller.js          -> req.userId, straight from
//                                           requireAuth (real Supabase
//                                           session, Database 1)
//
// No guest lookup, no recruiter_guests, no merged_user_id logic needed
// here — a logged-in user's id IS their permanent Database 2 identity.
// It gets there via syncUserToMessagingDB (called on every login, see
// hooks/useAuth.jsx + routes/syncUser.js), and any OLDER guest-authored
// conversations under a matching email get re-pointed onto this same id
// by claimGuestHistory (routes/syncUser.js) the first time that user logs
// in with a recruiter role. By the time a request hits this file, that
// re-pointing has already happened — this file just reads/writes using
// req.userId as-is.
//
// Auth: every route using this controller must run requireAuth first,
// so req.userId is always set.

import messagingAdminDB from "../lib/messagingAdminDB.js";
import { supabase } from "../config/supabase.js";
import * as notificationService from "../services/notificationService.js";

// Fire-and-forget wrapper for the WhatsApp notification. This must NEVER be
// awaited before res.json() — if the underlying WhatsApp/API call hangs or
// is slow, awaiting it here would hang the whole HTTP response, which is
// exactly what was making the frontend's "send" spinner spin forever even
// though the message had already saved successfully.
function notifyNewMessageInBackground(recipientId, senderName, jobTitle) {
  notificationService
    .notifyNewMessage(recipientId, senderName, jobTitle)
    .catch((err) => {
      console.error("[notifyNewMessage] failed (non-fatal):", err?.message || err);
    });
}

// =============================
// GET /messages/conversations
// List every conversation the logged-in user is part of.
// =============================
export const listConversations = async (req, res) => {
  const userId = req.userId;

  const { data, error } = await messagingAdminDB
    .from("conversations")
    .select(`
      id,
      last_message_at,
      participant_one,
      participant_two,
      p1:users!conversations_participant_one_fkey(id, display_name, avatar_url, role, org_name),
      p2:users!conversations_participant_two_fkey(id, display_name, avatar_url, role, org_name)
    `)
    .or(`participant_one.eq.${userId},participant_two.eq.${userId}`)
    .order("last_message_at", { ascending: false });

  if (error) return res.status(500).json({ message: error.message });

  // ✅ Sent as "other_user" (snake_case) — this is the exact key
  // Messages.jsx's normalizeConversation looks for. It was previously sent
  // as "otherUser" (camelCase), which normalizeConversation never matched,
  // so every conversation fell through to its "Applicant" fallback name.
  const conversations = data.map((c) => {
    const other = c.participant_one === userId ? c.p2 : c.p1;
    return {
      id: c.id,
      last_message_at: c.last_message_at,
      other_user: other,
      // also included flat, in case anything else reads these directly
      other_name: other?.display_name || null,
      other_avatar: other?.avatar_url || null,
    };
  });

  return res.json({ data: conversations });
};

// =============================
// GET /messages/conversations/:conversationId
// One conversation's full message history. Marks the other side's
// messages as read.
// =============================
export const getThread = async (req, res) => {
  const userId = req.userId;
  const { conversationId } = req.params;

  const { data: convo, error: convoErr } = await messagingAdminDB
    .from("conversations")
    .select("id, participant_one, participant_two")
    .eq("id", conversationId)
    .maybeSingle();

  if (convoErr) return res.status(500).json({ message: convoErr.message });
  if (!convo) return res.status(404).json({ message: "Conversation not found" });
  if (convo.participant_one !== userId && convo.participant_two !== userId) {
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
    .neq("sender_id", userId)
    .is("read_at", null);

  return res.json({ data: messages });
};

// =============================
// POST /messages/conversations/:conversationId/reply
// Reply inside an existing conversation.
// =============================
export const reply = async (req, res) => {
  const userId = req.userId;
  const { conversationId } = req.params;
  const { content } = req.body;
  if (!content?.trim()) return res.status(400).json({ message: "content is required" });

  const { data: convo, error: convoErr } = await messagingAdminDB
    .from("conversations")
    .select("id, participant_one, participant_two, job_id")
    .eq("id", conversationId)
    .maybeSingle();

  if (convoErr) return res.status(500).json({ message: convoErr.message });
  if (!convo) return res.status(404).json({ message: "Conversation not found" });
  if (convo.participant_one !== userId && convo.participant_two !== userId) {
    return res.status(403).json({ message: "Not a participant in this conversation" });
  }

  const { data: inserted, error: msgErr } = await messagingAdminDB
    .from("messages")
    .insert({ conversation_id: conversationId, sender_id: userId, content: content.trim() })
    .select("*")
    .single();
  if (msgErr) return res.status(500).json({ message: msgErr.message });

  const { error: touchErr } = await messagingAdminDB
    .from("conversations")
    .update({ last_message_at: new Date().toISOString() })
    .eq("id", conversationId);
  if (touchErr) {
    console.error("[reply] failed to bump last_message_at for", conversationId, touchErr);
  }

  // ✅ Respond to the browser now — the message is saved, that's the part
  // the "send" spinner is waiting on. Everything below (WhatsApp
  // notification) is best-effort and must not hold the response open.
  res.json({ ok: true, data: inserted });

  // ── Fire-and-forget notification, AFTER the response has been sent ──
  const recipientId = convo.participant_one === userId ? convo.participant_two : convo.participant_one;

  (async () => {
    let jobTitle = "your job posting";
    if (convo.job_id) {
      const { data: job } = await supabase.from("jobs").select("title").eq("id", convo.job_id).maybeSingle();
      if (job?.title) jobTitle = job.title;
    }

    const { data: senderUser } = await messagingAdminDB
      .from("users")
      .select("display_name")
      .eq("id", userId)
      .maybeSingle();

    notifyNewMessageInBackground(recipientId, senderUser?.display_name || "Someone", jobTitle);
  })().catch((err) => {
    console.error("[reply] background notification setup failed:", err?.message || err);
  });
};

// =============================
// POST /messages/start
// Start a NEW conversation with another user (e.g. a business messaging a
// candidate directly from a logged-in dashboard, not the guest flow).
// body: { otherUserId, content }
// =============================
export const startConversation = async (req, res) => {
  const userId = req.userId;
  const { otherUserId, content } = req.body;
  if (!otherUserId || !content?.trim()) {
    return res.status(400).json({ message: "otherUserId and content are required" });
  }

  const { data: existing, error: findErr } = await messagingAdminDB
    .from("conversations")
    .select("id")
    .or(
      `and(participant_one.eq.${userId},participant_two.eq.${otherUserId}),` +
        `and(participant_one.eq.${otherUserId},participant_two.eq.${userId})`
    )
    .maybeSingle();
  if (findErr) return res.status(500).json({ message: findErr.message });

  let conversationId = existing?.id;
  if (!conversationId) {
    const { data: created, error: convoErr } = await messagingAdminDB
      .from("conversations")
      .insert({ participant_one: userId, participant_two: otherUserId })
      .select("id")
      .single();
    if (convoErr) return res.status(500).json({ message: convoErr.message });
    conversationId = created.id;
  }

  const { error: msgErr } = await messagingAdminDB
    .from("messages")
    .insert({ conversation_id: conversationId, sender_id: userId, content: content.trim() });
  if (msgErr) return res.status(500).json({ message: msgErr.message });

  const { error: touchErr } = await messagingAdminDB
    .from("conversations")
    .update({ last_message_at: new Date().toISOString() })
    .eq("id", conversationId);
  if (touchErr) {
    console.error("[startConversation] failed to bump last_message_at for", conversationId, touchErr);
  }

  // ✅ Same fix as reply(): respond first, notify after.
  res.json({ ok: true, conversationId });

  (async () => {
    const { data: senderUser } = await messagingAdminDB
      .from("users")
      .select("display_name")
      .eq("id", userId)
      .maybeSingle();

    notifyNewMessageInBackground(otherUserId, senderUser?.display_name || "Someone", "your job posting");
  })().catch((err) => {
    console.error("[startConversation] background notification setup failed:", err?.message || err);
  });
};