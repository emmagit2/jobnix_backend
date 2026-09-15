// routes/syncUser.js
import express from 'express';
import { supabase } from '../config/supabase.js';
import messagingAdminDB, { syncUserToMessagingDB } from '../lib/messagingAdminDB.js';

const router = express.Router();

// -----------------------------------------------------------
// Claim any guest-recruiter history tied to this email.
//
// Runs on every sync-user call (every login/signup) — safe to call
// repeatedly, since it only does something the FIRST time it finds an
// unclaimed recruiter_guests row for this email.
//
// Two things happen:
//   1. recruiter_guests.merged_user_id gets set to the real account id.
//      (This makes upsertGuest() in guestMessages.js route any FUTURE
//      guest-sends from this email to the real account automatically —
//      that part of the logic already existed.)
//   2. Every EXISTING conversation/message that used the old guest id
//      gets re-pointed to the real account id. Without this step, old
//      conversations would stay invisible to the now-real account forever
//      — merged_user_id only affects messages sent AFTER claiming.
// -----------------------------------------------------------
async function claimGuestHistory({ id: realUserId, email }) {
  if (!email) return;
  const normalizedEmail = email.trim().toLowerCase();

  const { data: guest, error: findErr } = await supabase
    .from('recruiter_guests')
    .select('id, merged_user_id')
    .eq('email', normalizedEmail)
    .is('merged_user_id', null) // only unclaimed guests — skip if already done
    .maybeSingle();

  if (findErr) {
    console.error('[claimGuestHistory] lookup failed', findErr);
    return;
  }
  if (!guest) return; // no unclaimed guest history for this email

  const guestId = guest.id;

  // Step 1 — mark this guest row as claimed
  const { error: mergeErr } = await supabase
    .from('recruiter_guests')
    .update({ merged_user_id: realUserId })
    .eq('id', guestId);
  if (mergeErr) {
    console.error('[claimGuestHistory] merge update failed', mergeErr);
    return; // don't proceed to step 2 if step 1 failed
  }

  // Step 2 — re-point past conversations/messages from guestId to realUserId
  await messagingAdminDB
    .from('conversations')
    .update({ participant_one: realUserId })
    .eq('participant_one', guestId);

  await messagingAdminDB
    .from('conversations')
    .update({ participant_two: realUserId })
    .eq('participant_two', guestId);

  await messagingAdminDB
    .from('messages')
    .update({ sender_id: realUserId })
    .eq('sender_id', guestId);

  // The old guest's `users` row (Database 2) is now unreferenced — remove it
  // so the recruiter's real account is the only trace left behind.
  const { error: deleteErr } = await messagingAdminDB
    .from('users')
    .delete()
    .eq('id', guestId)
    .eq('role', 'guest_recruiter');
  if (deleteErr) {
    console.error('[claimGuestHistory] cleanup failed', deleteErr);
    // not fatal — worst case an unused row is left behind
  }
}

router.post('/api/sync-user', async (req, res) => {
  const { id, role, name, email, avatar_url, org_name } = req.body;
  if (!id || !role) {
    return res.status(400).json({ error: 'id and role are required' });
  }

  const result = await syncUserToMessagingDB({ id, role, name, email, avatar_url, org_name });

  // Only recruiters can have guest history to claim — jobseekers never
  // message as a "guest recruiter", so skip the lookup for them.
  if (role === 'recruiter') {
    await claimGuestHistory({ id, email });
  }

  res.json(result);
});

export default router;