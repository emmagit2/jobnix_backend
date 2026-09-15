// lib/businessProfilesRepo.js
import crypto from "crypto";
import { supabase } from "../config/supabase.js";

export async function findById(businessId) {
  const { data, error } = await supabase
    .from("business_profiles")
    .select("*, profiles!inner(id, email, account_type, created_at)")
    .eq("id", businessId)
    .maybeSingle();
  if (error) throw error;
  return data;
}

export async function findByPhone(phone) {
  const { data, error } = await supabase
    .from("business_profiles")
    .select("*, profiles!inner(id, email, account_type)")
    .eq("phone", phone)
    .eq("phone_verified", true)
    .maybeSingle();
  if (error) throw error;
  return data;
}

export async function findByPendingCode(code) {
  const { data, error } = await supabase
    .from("business_profiles")
    .select("id, phone_verification_code")
    .eq("phone_verification_code", code)
    .eq("phone_verified", false)
    .maybeSingle();
  if (error) throw error;
  return data;
}

// ── Profile detail fields ────────────────────────────────────────────
// Generic update for the fields the business owner edits directly from
// their profile page: business_name, industry, hiring_size, business_type,
// description, address, logo_url. NIN and phone go through the dedicated
// verify* functions below instead, since those always set a *_verified
// flag + timestamp together and shouldn't be editable as plain fields.
export async function updateProfileDetails(businessId, updates) {
  const ALLOWED = [
    "business_name", "owner_name", "industry", "hiring_size",
    "business_type", "description", "address", "logo_url",
    "latitude", "longitude",
  ];
  const safeUpdates = Object.fromEntries(
    Object.entries(updates).filter(([k]) => ALLOWED.includes(k))
  );
  const { data, error } = await supabase
    .from("business_profiles")
    .update({ ...safeUpdates, updated_at: new Date().toISOString() })
    .eq("id", businessId)
    .select()
    .single();
  if (error) throw error;
  return data;
}

export async function verifyNIN(businessId, ninNumber) {
  const { data, error } = await supabase
    .from("business_profiles")
    .update({
      nin_number: ninNumber,
      nin_verified: true,
      nin_verified_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq("id", businessId)
    .select()
    .single();
  if (error) throw error;
  return data;
}

// phone doubles as the WhatsApp number — see the onboarding profile UI's
// "This number receives all applicant messages" copy. Verifying it sets
// phone + phone_verified + phone_verified_at together in one write.
export async function verifyPhone(businessId, phone) {
  const { data, error } = await supabase
    .from("business_profiles")
    .update({
      phone,
      phone_verified: true,
      phone_verified_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq("id", businessId)
    .select()
    .single();
  if (error) throw error;
  return data;
}

export async function setPlan(businessId, plan) {
  const { data, error } = await supabase
    .from("business_profiles")
    .update({ plan, updated_at: new Date().toISOString() })
    .eq("id", businessId)
    .select()
    .single();
  if (error) throw error;
  return data;
}

export async function applyReferralCode(businessId, referralCode) {
  if (!referralCode) return;
  const { data: referrer } = await supabase
    .from("business_profiles")
    .select("id")
    .eq("referral_code", referralCode)
    .maybeSingle();
  if (!referrer || referrer.id === businessId) return; // unknown code or self-referral
  const { data: self } = await supabase.from("business_profiles").select("referred_by").eq("id", businessId).single();
  if (self?.referred_by) return; // already credited to someone
  await supabase.from("business_profiles").update({ referred_by: referrer.id }).eq("id", businessId);
  await supabase.from("referrals").insert({ referrer_id: referrer.id, referred_id: businessId, status: "pending" });
}

export async function getReferralStats(businessId) {
  const business = await findById(businessId);
  const { data: referrals, error } = await supabase
    .from("referrals")
    .select("id, status, reward_credits, created_at")
    .eq("referrer_id", businessId)
    .order("created_at", { ascending: false });
  if (error) throw error;
  return {
    referralCode: business?.referral_code,
    totalCredits: business?.referral_credits || 0,
    totalReferred: referrals.length,
    completed: referrals.filter((r) => r.status === "completed").length,
    referrals,
  };
}

// Ensures a business always has a referral_code, generating one lazily the
// first time it's needed (covers accounts created before the migration ran,
// or if the migration's backfill somehow missed a row).
export async function ensureReferralCode(businessId) {
  const business = await findById(businessId);
  if (business?.referral_code) return business.referral_code;
  const code = crypto.randomBytes(5).toString("hex");
  await supabase.from("business_profiles").update({ referral_code: code }).eq("id", businessId);
  return code;
}

export async function remove(businessId) {
  // Deletes the auth.users row too, which cascades through profiles ->
  // business_profiles -> everything else via ON DELETE CASCADE.
  const { error } = await supabase.auth.admin.deleteUser(businessId);
  if (error) throw error;
}