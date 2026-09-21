// lib/conversations.js
//
// Shared helper for the messaging database (DB2).
// Used by:
//   - controllers/applications.controller.js  (createApplication, informal jobs)
//   - controllers/jobs.controller.js          (openApplicantChat / applyToJob)
//
// What it does:
//   1. Makes sure BOTH people exist in DB2's `users` table (conversation rows
//      reference them, so an unsynced user makes the insert fail).
//   2. Finds the existing conversation between the two people (either
//      participant order) or creates a new one.
//   3. Tags the conversation with the job it started from (if it has none yet).

import { supabase } from "../config/supabase.js";
import messagingAdminDB, { syncUserToMessagingDB } from "./messagingAdminDB.js";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Mirror the business + applicant from DB1 into DB2's users table.
// Returns the applicant's display name (handy for the first message).
async function syncBoth(businessId, applicantId) {
  const [{ data: biz }, { data: person }] = await Promise.all([
    supabase
      .from("business_profiles")
      .select("business_name, owner_name, logo_url")
      .eq("id", businessId)
      .maybeSingle(),
    supabase
      .from("user_profiles")
      .select("full_name, avatar_url")
      .eq("id", applicantId)
      .maybeSingle(),
  ]);

  await syncUserToMessagingDB({
    id: businessId,
    role: "business",
    name: biz?.business_name || biz?.owner_name || "Business",
    avatar_url: biz?.logo_url ?? null,
    org_name: biz?.business_name ?? null,
  });

  await syncUserToMessagingDB({
    id: applicantId,
    role: "jobseeker",
    name: person?.full_name || "Applicant",
    avatar_url: person?.avatar_url ?? null,
  });

  return person?.full_name || "A candidate";
}

/**
 * @param {{ businessId: string, applicantId: string, jobId?: string|null }} args
 * @returns {Promise<{ conversationId: string, applicantName: string }>}
 */
export async function findOrCreateConversation({ businessId, applicantId, jobId }) {
  // Keeps anything that isn't a UUID out of the .or() filter string below.
  if (!UUID_RE.test(String(businessId)) || !UUID_RE.test(String(applicantId))) {
    throw new Error("Invalid participant id");
  }

  const applicantName = await syncBoth(businessId, applicantId);

  // Look in both participant orders. .limit(1) means a duplicate row (from a
  // race) won't make .maybeSingle() throw.
  const { data: existing, error: findErr } = await messagingAdminDB
    .from("conversations")
    .select("id, job_id")
    .or(
      `and(participant_one.eq.${businessId},participant_two.eq.${applicantId}),` +
        `and(participant_one.eq.${applicantId},participant_two.eq.${businessId})`
    )
    .limit(1)
    .maybeSingle();
  if (findErr) throw findErr;

  if (existing) {
    // Conversation existed before but wasn't tied to a job yet — tag it now.
    if (!existing.job_id && jobId) {
      await messagingAdminDB
        .from("conversations")
        .update({ job_id: jobId })
        .eq("id", existing.id);
    }
    return { conversationId: existing.id, applicantName };
  }

  const { data: created, error: createErr } = await messagingAdminDB
    .from("conversations")
    .insert({
      participant_one: businessId,
      participant_two: applicantId,
      job_id: jobId ?? null,
    })
    .select("id")
    .single();
  if (createErr) throw createErr;

  return { conversationId: created.id, applicantName };
}