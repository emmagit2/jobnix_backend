// Uses the MAIN database client (auth.users, profiles, business_profiles,
// payments) — same client jobsRepo.js and businessProfilesRepo.js use.
// NOT the pg Pool (raw .query() only, no .from()) and NOT messagingAdminDB
// (that's the separate messaging DB, Database 2).
import { supabase } from "../config/supabase.js";
import { REFERRAL_REWARD_CREDITS } from "../config/plans.js";

export async function create({ businessId, jobId, reference, amountKobo, purpose }) {
  const { data, error } = await supabase
    .from("payments")
    .insert({ business_id: businessId, job_id: jobId, reference, amount_kobo: amountKobo, purpose })
    .select()
    .single();
  if (error) throw error;
  return data;
}

export async function findByReference(reference) {
  const { data, error } = await supabase.from("payments").select("*").eq("reference", reference).maybeSingle();
  if (error) throw error;
  return data;
}

export async function markSuccess(reference, paystackRaw) {
  const { data, error } = await supabase
    .from("payments")
    .update({ status: "success", paystack_raw: paystackRaw, updated_at: new Date().toISOString() })
    .eq("reference", reference)
    .select()
    .single();
  if (error) throw error;
  await rewardReferrerOnFirstPayment(data.business_id);
  return data;
}

async function rewardReferrerOnFirstPayment(businessId) {
  const { data: pending } = await supabase
    .from("referrals")
    .select("*")
    .eq("referred_id", businessId)
    .eq("status", "pending")
    .maybeSingle();
  if (!pending) return;

  await supabase
    .from("referrals")
    .update({ status: "completed", reward_credits: REFERRAL_REWARD_CREDITS })
    .eq("id", pending.id);

  const { data: referrer } = await supabase
    .from("business_profiles")
    .select("referral_credits")
    .eq("id", pending.referrer_id)
    .single();

  await supabase
    .from("business_profiles")
    .update({ referral_credits: (referrer?.referral_credits || 0) + REFERRAL_REWARD_CREDITS })
    .eq("id", pending.referrer_id);
}