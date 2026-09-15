// lib/recruiterHubQueries.js
//
// Shared between recruiterHub.controller.js (listHubJobs) and
// applications.controller.js (verifyRecruiterCode, which now needs to
// hand back this recruiter's FULL job list — not just the one job their
// token was for — so redirecting into the hub lands them somewhere
// already populated).

import { supabase } from "../config/supabase.js";

// Every 'platform' job whose recruiter_email matches, with applicant_count
// computed alongside. posted_at:created_at aliases your default Supabase
// timestamp column to the name the frontend expects.
export async function fetchJobsWithCounts(email) {
  const { data: jobs, error } = await supabase
    .from("jobs")
    .select("id, title, location, job_type, posted_at:created_at")
    .eq("recruiter_email", email)
    .eq("apply_method", "platform")
    .order("created_at", { ascending: false });
  if (error) throw error;
  if (!jobs?.length) return [];

  const { data: apps, error: countErr } = await supabase
    .from("applications")
    .select("job_id")
    .in("job_id", jobs.map((j) => j.id));
  if (countErr) throw countErr;

  const countByJob = apps.reduce((acc, a) => {
    acc[a.job_id] = (acc[a.job_id] || 0) + 1;
    return acc;
  }, {});

  return jobs.map((j) => ({ ...j, applicant_count: countByJob[j.id] || 0 }));
}