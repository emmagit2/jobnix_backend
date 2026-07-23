import { supabase } from "../config/supabase.js";

// visitor_id is ALWAYS server-issued via an httpOnly cookie, and user_id is
// resolved server-side from an optional bearer token (see
// controllers/analytics.controller.js → jobClickController / getOptionalUserId).
// Never accept either from req.body directly — that would let anyone spoof
// unique visitors or attribute clicks to another user.
export const trackJobClick = async ({
  job_id,
  job_title,
  company,
  role_category,
  location,
  referrer,
  visitor_id,
  user_id = null,
}) => {
  const { data, error } = await supabase
    .from("job_clicks")
    .insert([{ job_id, job_title, company, role_category, location, referrer, visitor_id, user_id }])
    .select()
    .single();

  if (error) throw new Error(error.message);
  return data;
};

export const getAllClicks = async () => {
  const { data, error } = await supabase
    .from("job_clicks")
    .select("*")
    .order("created_at", { ascending: false });

  if (error) throw new Error(error.message);
  return data;
};

// NOTE: All aggregation (topJobs, locations, categories, referrers, visitor
// stats, clicksOverTime) lives ONLY in analytics.controller.js
// (analyticsOverviewController). Do not add a second aggregation function
// here — that's what caused the two implementations to drift apart before.