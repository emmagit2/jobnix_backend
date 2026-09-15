// lib/userAccount.js
import { supabase } from './supabaseAdmin.js';
import { attachGuestHistoryIfRecruiter } from './guestMerge.js';

/**
 * The one function all signup flows (Gmail business, Facebook business,
 * corporate email) call at the end of signup — and the one place any
 * later role change (e.g. upgrading to 'recruiter') should also go through.
 *
 * @param {{ id: string, email: string, role: string, account_type: 'jobseeker'|'business'|'corporate', [key: string]: any }} params
 */
export async function createOrUpdateUser({ id, email, role, account_type, ...rest }) {
  const { data: profile, error } = await supabase
    .from('profiles')
    .upsert({ id, email, role, account_type, ...rest }, { onConflict: 'id' })
    .select()
    .single();

  if (error) throw error;

  // In-process, no webhook/tunnel needed — runs on every signup and every
  // later profile update that goes through this function. If role wasn't
  // 'recruiter', this is a cheap no-op.
  await attachGuestHistoryIfRecruiter({ id, email, role, account_type });

  return profile;
}