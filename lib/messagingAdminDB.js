// messagingAdminDB.js
// Server-side ONLY. Never import this file into frontend/client bundle code.

import { createClient } from '@supabase/supabase-js';

const messagingAdminDB = createClient(
  process.env.MESSAGING_SUPABASE_URL,
  process.env.MESSAGING_SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false } }
);

/**
 * Mirrors a user (candidate or business) from Database 1 into Database 2's users table.
 * Safe to call on every signup and every login (upsert = create-or-update).
 *
 * @param {{ id: string, role: string, name?: string, avatar_url?: string }} user
 */
export async function syncUserToMessagingDB(user) {
  if (!user?.id || !user?.role) {
    throw new Error('syncUserToMessagingDB: user.id and user.role are required');
  }
  const { error } = await messagingAdminDB
    .from('users')
    .upsert(
      {
        id: user.id,
        role: user.role,
        display_name: user.name ?? null,
        avatar_url: user.avatar_url ?? null,
        org_name: user.org_name ?? null,
      },
      { onConflict: 'id' }
    );
  if (error) {
    console.error('[messaging-sync] upsert failed for user', user.id, error);
    return { ok: false, error };
  }
  return { ok: true };
}

export default messagingAdminDB;