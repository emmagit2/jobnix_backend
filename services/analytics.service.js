import { supabase } from "../config/supabase.js";

// visitor_id is ALWAYS server-issued via an httpOnly cookie, and user_id is
// resolved server-side from an optional bearer token (see
// controllers/analytics.controller.js → jobClickController / getOptionalUserId).
// Never accept either from req.body directly — that would let anyone spoof
// unique visitors or attribute clicks to another user.
//
// user_agent / is_bot are also server-derived (from request headers), never
// from req.body.
export const trackJobClick = async ({
  job_id,
  job_title,
  company,
  role_category,
  location,
  referrer,
  visitor_id,
  user_id = null,
  event_type = "view",
  user_agent = null,
  is_bot = false,
  human_verified = false,
  visitor_country = null,
  visitor_region = null,
  visitor_city = null,
}) => {
  const { data, error } = await supabase
    .from("job_clicks")
    .insert([
      {
        job_id, job_title, company, role_category, location, referrer,
        visitor_id, user_id, event_type, user_agent, is_bot, human_verified,
        visitor_country, visitor_region, visitor_city,
      },
    ])
    .select()
    .single();
  if (error) throw new Error(error.message);
  return data;
};

// Returns every non-bot click. Supabase caps a single query at 1,000 rows, so
// we page through with .range() until a short page comes back — otherwise the
// oldest rows silently disappear once the table grows past 1,000.
// Bots are stored (so you can audit them) but excluded here.
export const getAllClicks = async ({ includeBots = false } = {}) => {
  const PAGE = 1000;
  let all = [];
  let from = 0;

  while (true) {
    let query = supabase
      .from("job_clicks")
      .select("*")
      .order("created_at", { ascending: false })
      .range(from, from + PAGE - 1);

    if (!includeBots) query = query.eq("is_bot", false);

    const { data, error } = await query;
    if (error) throw new Error(error.message);

    all = all.concat(data);
    if (data.length < PAGE) break;
    from += PAGE;
  }
  return all;
};

// NOTE: All aggregation (topJobs, locations, categories, referrers, visitor
// stats, clicksOverTime, jobCounts) lives ONLY in analytics.controller.js
// (analyticsOverviewController). Do not add a second aggregation function
// here — that's what caused the two implementations to drift apart before.