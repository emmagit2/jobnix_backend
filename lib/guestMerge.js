// lib/guestMerge.js
import { supabase } from "../config/supabase.js";
import { mergeGuestIntoRecruiter } from './messagingAdminDB.js';
 
export async function attachGuestHistoryIfRecruiter({ id, email, role, account_type }) {
  if (role !== 'recruiter' || !email) return { merged: false };

  const normalizedEmail = email.trim().toLowerCase();

  const { data: guest } = await supabase
    .from('recruiter_guests')
    .select('*')
    .eq('email', normalizedEmail)
    .is('merged_user_id', null)
    .maybeSingle();

  if (!guest) return { merged: false };

  await mergeGuestIntoRecruiter({
    guestId: guest.id,
    realUserId: id,
    name: guest.name,
    orgName: guest.company ?? null,
  });

  await supabase
    .from('recruiter_guests')
    .update({ merged_user_id: id })
    .eq('id', guest.id);

  return { merged: true, accountType: account_type };
}