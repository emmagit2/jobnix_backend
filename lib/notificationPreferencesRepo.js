// lib/notificationPreferencesRepo.js
import { supabase } from "../config/supabase.js";

const DEFAULTS = {
  new_applicant: true,
  job_expiring_soon: true,
  messages: true,
  weekly_summary: true,
  application_status_change: true,
  payment_success: true,
  referral_commission: true,
};

const UPDATABLE_KEYS = [
  "new_applicant",
  "job_expiring_soon",
  "messages",
  "weekly_summary",
  "application_status_change",
  "payment_success",
  "referral_commission",
];

export async function get(businessId) {
  const { data, error } = await supabase
    .from("notification_preferences")
    .select("*")
    .eq("business_id", businessId)
    .maybeSingle();
  if (error) throw error;

  if (!data) {
    const { data: created, error: createErr } = await supabase
      .from("notification_preferences")
      .insert({ business_id: businessId, ...DEFAULTS })
      .select()
      .single();
    if (createErr) throw createErr;
    return created;
  }
  return data;
}

export async function update(businessId, prefs) {
  // Ensure a row exists first (accounts created before this add-on won't have one yet)
  await get(businessId);

  const patch = {};
  for (const key of UPDATABLE_KEYS) {
    if (typeof prefs[key] === "boolean") patch[key] = prefs[key];
  }
  patch.updated_at = new Date().toISOString();

  const { data, error } = await supabase
    .from("notification_preferences")
    .update(patch)
    .eq("business_id", businessId)
    .select()
    .single();
  if (error) throw error;
  return data;
}