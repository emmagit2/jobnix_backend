 // routes/guestMessages.js
import express from 'express';
import { randomUUID } from 'crypto';
import { supabase } from "../config/supabase.js";
import messagingAdminDB, { syncUserToMessagingDB } from '../lib/messagingAdminDB.js';
import { signGuestConversationToken, verifyGuestConversationToken } from '../lib/guestToken.js';
import { sendCandidateNewMessageEmail } from '../lib/resendEmail.js';

const router = express.Router();

// Keeps anything that isn't a UUID out of the .or() filter string below.
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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
//
// Privacy: candidates whose profile is Hidden can't be messaged.
// -----------------------------------------------------------
router.post('/api/messages/guest-send', async (req, res) => {
  const { candidateId, name, email, company, content } = req.body;

  if (!candidateId || !name?.trim() || !email?.trim() || !content?.trim()) {
    return res.status(400).json({ error: 'candidateId, name, email, and content are required' });
  }

  // candidateId is used inside a query filter string below, so it must be a UUID.
  if (!UUID_RE.test(String(candidateId))) {
    return res.status(400).json({ error: 'Invalid candidate.' });
  }

  if (isFreeEmailDomain(email)) {
    return res.status(400).json({
      error:
        "We don't accept messages from personal email addresses (Gmail, Yahoo, Outlook, etc.). Please use your company email address so we can validate your request.",
      code: 'FREE_EMAIL_DOMAIN_NOT_ALLOWED',
    });
  }

  try {
    // The candidate must exist and must not be Hidden. Same answer for both,
    // so this endpoint can't be used to find out which ids are real.
    const { data: candidate } = await supabase
      .from('user_profiles')
      .select('id, full_name, avatar_url, profile_visibility')
      .eq('id', candidateId)
      .maybeSingle();

    if (!candidate || candidate.profile_visibility === 'hidden') {
      return res.status(404).json({ error: "This candidate can't be messaged." });
    }

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

    // The conversation row references the candidate in the messaging DB, so
    // make sure they exist there too (otherwise the insert below can fail).
    await syncUserToMessagingDB({
      id: candidate.id,
      role: 'jobseeker',
      name: candidate.full_name || 'Candidate',
      avatar_url: candidate.avatar_url ?? null,
    });

    const { data: existingConvo } = await messagingAdminDB
      .from('conversations')
      .select('id')
      .or(
        `and(participant_one.eq.${messagingIdentity},participant_two.eq.${candidate.id}),and(participant_one.eq.${candidate.id},participant_two.eq.${messagingIdentity})`
      )
      .limit(1)
      .maybeSingle();

    let conversationId = existingConvo?.id;
    if (!conversationId) {
      const { data: createdConvo, error: createErr } = await messagingAdminDB
        .from('conversations')
        .insert({ participant_one: messagingIdentity, participant_two: candidate.id })
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

    // The message is saved at this point. Emailing the candidate is
    // best-effort: if it fails, the visitor should still see "sent".
    try {
      const { data: candidateProfile } = await supabase
        .from('profiles')
        .select('email')
        .eq('id', candidate.id)
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
    } catch (emailErr) {
      console.error('[guest-send] message saved, but email to candidate failed:', emailErr?.message || emailErr);
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