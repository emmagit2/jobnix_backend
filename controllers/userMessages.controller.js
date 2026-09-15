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

  const conversations = data.map((c) => ({
    id: c.id,
    last_message_at: c.last_message_at,
    otherUser: c.participant_one === userId ? c.p2 : c.p1,
  }));

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

  // Was previously fire-and-forget with no error check — if this silently
  // failed (bad id cast, RLS, etc.) the inbox would show a stale
  // last_message_at even after a hard refresh, with no error surfaced
  // anywhere. Now we check it and log loudly if it fails, since the
  // message itself already sent successfully and we don't want to fail
  // the whole request over a secondary write.
  const { error: touchErr } = await messagingAdminDB
    .from("conversations")
    .update({ last_message_at: new Date().toISOString() })
    .eq("id", conversationId);
  if (touchErr) {
    console.error("[reply] failed to bump last_message_at for", conversationId, touchErr);
  }

  // WhatsApp notification to the other participant, if they're a business
  // with a verified phone and the "Messages" preference enabled — no-ops
  // silently otherwise (see lib/notificationService.js).
  const recipientId = convo.participant_one === userId ? convo.participant_two : convo.participant_one;

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

  await notificationService.notifyNewMessage(recipientId, senderUser?.display_name || "Someone", jobTitle);

  return res.json({ ok: true, data: inserted });
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

  // WhatsApp notification to the recipient, if they're a business with a
  // verified phone and the "Messages" preference enabled — no-ops silently
  // otherwise. startConversation never tags job_id, so no job title to look
  // up here (unlike reply, above).
  const { data: senderUser } = await messagingAdminDB
    .from("users")
    .select("display_name")
    .eq("id", userId)
    .maybeSingle();

  await notificationService.notifyNewMessage(otherUserId, senderUser?.display_name || "Someone", "your job posting");

  return res.json({ ok: true, conversationId });
};