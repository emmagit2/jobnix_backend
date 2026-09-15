// lib/jobsRepo.js
import { supabase } from "../config/supabase.js";

// Ownership model: `companies` has no link back to an account (just name/RC
// number/logo — it's a directory, not an owner record). Real ownership comes
// from `jobs.recruiter_email` for formal jobs (matched against the guest-
// recruiter flow), OR from `jobs.submitted_by_business_id` for informal jobs
// (set directly at creation by submitInformalJob) — see findByIdForBusiness.

async function ownerEmail(businessId) {
  const { data, error } = await supabase.from("profiles").select("email").eq("id", businessId).maybeSingle();
  if (error) throw error;
  return (data?.email || "").toLowerCase() || null;
}

// Given a job, resolves which business_profiles/profiles id (if any) should
// receive notifications/messages for it. Returns null for a job posted by a
// guest recruiter who hasn't created a real account yet — nothing to notify.
export async function resolveBusinessIdForJob(job) {
  if (!job.recruiter_email) return null;
  const email = job.recruiter_email.toLowerCase();

  const { data: account } = await supabase
    .from("profiles")
    .select("id")
    .ilike("email", email)
    .in("account_type", ["business", "corporate"])
    .maybeSingle();
  if (account) return account.id;

  // No full account yet — check whether this guest has since been claimed
  // (your existing claimGuestHistory flow sets merged_user_id on signup)
  const { data: guest } = await supabase
    .from("recruiter_guests")
    .select("merged_user_id")
    .ilike("email", email)
    .maybeSingle();
  return guest?.merged_user_id || null;
}

export async function countActiveForBusiness(businessId) {
  const email = await ownerEmail(businessId);
  if (!email) return 0;

  const { count, error } = await supabase
    .from("jobs")
    .select("id", { count: "exact", head: true })
    .ilike("recruiter_email", email)
    .gte("deadline", new Date().toISOString().slice(0, 10));
  if (error) throw error;
  return count || 0;
}

export async function incrementView(jobId) {
  const { data, error } = await supabase.rpc("increment_job_view", { p_job_id: jobId });
  if (error) throw error;
  return data?.[0] || null;
}

export async function incrementClick(jobId) {
  const { data, error } = await supabase.rpc("increment_job_click", { p_job_id: jobId });
  if (error) throw error;
  return data?.[0] || null;
}

export async function incrementApplicationCount(jobId) {
  const { data, error } = await supabase.rpc("increment_job_application", { p_job_id: jobId });
  if (error) throw error;
  return data?.[0] || null;
}

export async function findById(jobId) {
  const { data, error } = await supabase.from("jobs").select("*").eq("id", jobId).maybeSingle();
  if (error) throw error;
  return data;
}

export async function findByIdForBusiness(jobId, businessId) {
  const job = await findById(jobId);
  if (!job) return null;

  // Informal jobs are owned directly via submitted_by_business_id (set by
  // submitInformalJob at creation time) — this is the reliable link and
  // doesn't depend on recruiter_email being set. recruiter_email is only
  // populated when apply_method === "platform"; informal jobs submitted
  // with apply_method "instructions" (the normal case) have it as null,
  // which made this function always report "not found" for them.
  if (job.submitted_by_business_id && job.submitted_by_business_id === businessId) {
    return job;
  }

  // Formal jobs (posted via createJob) are owned via recruiter_email
  // matching the business's account email — same model used elsewhere in
  // this file (listByBusiness, countActiveForBusiness, etc).
  if (!job.recruiter_email) return null;
  const email = await ownerEmail(businessId);
  return email && job.recruiter_email.toLowerCase() === email ? job : null;
}

export async function listByBusiness(businessId) {
  const email = await ownerEmail(businessId);
  if (!email) return [];

  const { data, error } = await supabase
    .from("jobs")
    .select("*")
    .ilike("recruiter_email", email)
    .order("created_at", { ascending: false });
  if (error) throw error;
  return data;
}

// Fuzzy title match scoped to one business — used by the Gemini WhatsApp assistant
export async function findByTitleForBusiness(businessId, titleQuery) {
  const email = await ownerEmail(businessId);
  if (!email) return null;

  const { data, error } = await supabase
    .from("jobs")
    .select("*")
    .ilike("recruiter_email", email)
    .ilike("title", `%${titleQuery}%`)
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  return data;
}

// Jobs whose `deadline` falls within the next `withinDays`, not yet notified —
// used by the "Job Expiring Soon" WhatsApp notification cron endpoint.
export async function findExpiringSoon(withinDays = 3) {
  const today = new Date().toISOString().slice(0, 10);
  const cutoff = new Date(Date.now() + withinDays * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

  const { data, error } = await supabase
    .from("jobs")
    .select("id, title, deadline, recruiter_email")
    .gte("deadline", today)
    .lte("deadline", cutoff)
    .is("deadline_notified_at", null);
  if (error) throw error;
  return data;
}

export async function markDeadlineNotified(jobId) {
  const { error } = await supabase
    .from("jobs")
    .update({ deadline_notified_at: new Date().toISOString() })
    .eq("id", jobId);
  if (error) throw error;
}

// Marks an informal job's payment as complete once Paystack confirms it —
// called from paymentController.js's finalizePaymentIfSuccessful. Idempotent
// (the payment_status: "pending" filter means a repeat call, e.g. from both
// the callback and the webhook, just no-ops the second time).
export async function markInformalJobPaid(jobId, reference) {
  const { data, error } = await supabase
    .from("jobs")
    .update({
      payment_status: "paid",
      payment_reference: reference,
      paid_at: new Date().toISOString(),
    })
    .eq("id", jobId)
    .eq("payment_status", "pending")
    .select()
    .maybeSingle();
  if (error) throw error;
  return data;
} 