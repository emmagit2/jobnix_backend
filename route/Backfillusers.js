// routes/backfillUsers.js
// ONE-TIME USE — mirrors every existing onboarded user from Database 1
// into Database 2's `users` table. Visit this route's URL once in your
// browser (while logged in as an admin, or protected however you like),
// then you can delete this file or leave it — it's safe to re-run any
// time since it uses upsert.

import express from 'express';
import { supabase } from '../config/supabase.js';
import { syncUserToMessagingDB } from '../lib/messagingAdminDB.js';

const router = express.Router();

router.get('/api/admin/backfill-users', async (req, res) => {
  try {
    // 1. Pull every onboarded profile from Database 1, joined with the
    //    role-specific tables (same shape as AuthProvider.jsx's query).
    const { data: profiles, error } = await supabase
      .from('profiles')
      .select('id, email, account_type, user_profiles(full_name, avatar_url), business_profiles(business_name)')
      .not('account_type', 'is', null);

    if (error) throw error;

    const results = { synced: 0, skipped: 0, failed: [] };

    for (const p of profiles) {
      let payload;

      if (p.account_type === 'jobseeker') {
        payload = {
          id: p.id,
          role: 'jobseeker',
          name: p.user_profiles?.full_name ?? null,
          avatar_url: p.user_profiles?.avatar_url ?? null,
        };
      } else if (p.account_type === 'business') {
        payload = {
          id: p.id,
          role: 'business',
          name: p.business_profiles?.business_name ?? null,
          avatar_url: null,
        };
      } else if (p.account_type === 'corporate') {
        const { data: membership } = await supabase
          .from('corp_members')
          .select('corp_organizations(name)')
          .eq('user_id', p.id)
          .maybeSingle();

        payload = {
          id: p.id,
          role: 'corporate',
          name: p.email ?? null,
          avatar_url: null,
          org_name: membership?.corp_organizations?.name ?? null,
        };
      } else {
        results.skipped++;
        continue;
      }

      const result = await syncUserToMessagingDB(payload);
      if (result.ok) {
        results.synced++;
      } else {
        results.failed.push({ id: p.id, error: result.error?.message });
      }
    }

    res.json({ success: true, total: profiles.length, ...results });
  } catch (err) {
    console.error('[backfill-users] failed', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

export default router;