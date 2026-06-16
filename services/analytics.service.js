import { supabase } from "../config/supabase.js";



export const trackJobClick = async ({ job_id, job_title, company, role_category, location, referrer, visitor_id }) => {
  const { data, error } = await supabase
    .from("job_clicks")
    .insert([{ job_id, job_title, company, role_category, location, referrer, visitor_id }])
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