// routes/guestMessages.js
import express from 'express';
import { randomUUID } from 'crypto';
import { supabase } from "../config/supabase.js";
import messagingAdminDB, { syncUserToMessagingDB } from '../lib/messagingAdminDB.js';
import { signGuestConversationToken, verifyGuestConversationToken } from '../lib/guestToken.js';
import { sendCandidateNewMessageEmail } from '../lib/resendEmail.js';

const router = express.Router();

// Free/personal email providers we don't accept for recruiter outreach.
// Recruiters must message candidates from a company email address so the
// candidate can trust who's contacting them. Keep this list in sync with
// the client-side check in JobSeekerProfile.jsx (that one is just UX —
// this is the real enforcement).
const FREE_EMAIL_DOMAINS = new Set([
  'gmail.com', 'googlemail.com',
  'yahoo.com', 'yahoo.co.uk', 'yahoo.co.in', 'ymail.com', 'rocketmail.com',
  'outlook.com', 'hotmail.com', 'hotmail.co.uk', 'live.com', 'msn.com',
  'aol.com', 'icloud.com', 'me.com', 'mac.com',
  'protonmail.com', 'proton.me', 'mail.com', 'gmx.com', 'zoho.com',
]);

function isFreeEmailDomain(email) {
  const domain = email.trim().toLowerCase().split('@')[1];
  return !!domain && FREE_EMAIL_DOMAINS.has(domain);
}

async function upsertGuest({ email, name, company }) {
  const normalizedEmail = email.trim().toLowerCase();

  const { data: existing } = await supabase
    .from('recruiter_guests')
    .select('*')
    .eq('email', normalizedEmail)
    .maybeSingle();

  if (existing) {
    await supabase
      .from('recruiter_guests')
      .update({ name, company: company ?? existing.company, updated_at: new Date().toISOString() })
      .eq('id', existing.id);
    return existing;
  }

  const { data: created, error } = await supabase
    .from('recruiter_guests')
    .insert({ id: randomUUID(), email: normalizedEmail, name, company: company ?? null })
    .select('*')
    .single();

  if (error) throw error;
  return created;
}

// -----------------------------------------------------------
// POST /api/messages/guest-send
// Public — no login. Used by the "Message Candidate" button on the
// public profile page. Body: { candidateId, name, email, company, content }
//
// Company-email-only policy: guests must send from a work email address,
// not a free/personal provider (gmail, yahoo, outlook, etc). Enforced here
// server-side — the client-side check is just UX and can be bypassed.
// -----------------------------------------------------------
router.post('/api/messages/guest-send', async (req, res) => {
  const { candidateId, name, email, company, content } = req.body;

  if (!candidateId || !name?.trim() || !email?.trim() || !content?.trim()) {
    return res.status(400).json({ error: 'candidateId, name, email, and content are required' });
  }

  if (isFreeEmailDomain(email)) {
    return res.status(400).json({
      error:
        "We don't accept messages from personal email addresses (Gmail, Yahoo, Outlook, etc.). Please use your company email address so we can validate your request.",
      code: 'FREE_EMAIL_DOMAIN_NOT_ALLOWED',
    });
  }

  try {
    const guest = await upsertGuest({ email, name: name.trim(), company });

    // If this email already belongs to a real recruiter account, send as
    // that account instead of the guest id — they've "graduated".
    const messagingIdentity = guest.merged_user_id ?? guest.id;

    await syncUserToMessagingDB({
      id: messagingIdentity,
      role: guest.merged_user_id ? 'recruiter' : 'guest_recruiter',
      name: guest.name,
      email: guest.email,
      org_name: company ?? null,
    });

    const { data: existingConvo } = await messagingAdminDB
      .from('conversations')
      .select('id')
      .or(
        `and(participant_one.eq.${messagingIdentity},participant_two.eq.${candidateId}),and(participant_one.eq.${candidateId},participant_two.eq.${messagingIdentity})`
      )
      .maybeSingle();

    let conversationId = existingConvo?.id;
    if (!conversationId) {
      const { data: createdConvo, error: createErr } = await messagingAdminDB
        .from('conversations')
        .insert({ participant_one: messagingIdentity, participant_two: candidateId })
        .select('id')
        .single();
      if (createErr) throw createErr;
      conversationId = createdConvo.id;
    }

    const { error: msgErr } = await messagingAdminDB
      .from('messages')
      .insert({ conversation_id: conversationId, sender_id: messagingIdentity, content: content.trim() });
    if (msgErr) throw msgErr;

    await messagingAdminDB
      .from('conversations')
      .update({ last_message_at: new Date().toISOString() })
      .eq('id', conversationId);

    // Notify the candidate by email — they may not be checking the app.
    const { data: candidateProfile } = await supabase
      .from('profiles')
      .select('email')
      .eq('id', candidateId)
      .maybeSingle();

    if (candidateProfile?.email) {
      await sendCandidateNewMessageEmail({
        to: candidateProfile.email,
        fromName: guest.name,
        fromCompany: company ?? null,
        messagePreview: content.trim(),
        appUrl: `${process.env.APP_URL}/inbox`,
      });
    }

    res.json({ ok: true, conversationId });
  } catch (err) {
    console.error('[guest-send] failed', err);
    res.status(500).json({ error: 'Could not send message' });
  }
});

// -----------------------------------------------------------
// GET /api/messages/guest/:token
// View a single conversation via the signed link sent in reply emails.
// No login — the token itself is the credential, scoped to one conversation.
// -----------------------------------------------------------
router.get('/api/messages/guest/:token', async (req, res) => {
  try {
    const { guestId, conversationId } = verifyGuestConversationToken(req.params.token);

    const { data: messages, error } = await messagingAdminDB
      .from('messages')
      .select('id, sender_id, content, created_at')
      .eq('conversation_id', conversationId)
      .order('created_at', { ascending: true });
    if (error) throw error;

    res.json({ guestId, conversationId, messages });
  } catch {
    res.status(401).json({ error: 'This link is invalid or has expired.' });
  }
});

// -----------------------------------------------------------
// POST /api/messages/guest/:token/reply
// Body: { content }
// -----------------------------------------------------------
router.post('/api/messages/guest/:token/reply', async (req, res) => {
  const { content } = req.body;
  if (!content?.trim()) return res.status(400).json({ error: 'content is required' });

  try {
    const { guestId, conversationId } = verifyGuestConversationToken(req.params.token);

    const { error } = await messagingAdminDB
      .from('messages')
      .insert({ conversation_id: conversationId, sender_id: guestId, content: content.trim() });
    if (error) throw error;

    await messagingAdminDB
      .from('conversations')
      .update({ last_message_at: new Date().toISOString() })
      .eq('id', conversationId);

    res.json({ ok: true });
  } catch {
    res.status(401).json({ error: 'This link is invalid or has expired.' });
  }
});

export default router;