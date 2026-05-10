import { supabase } from "../config/supabase.js";

// ✅ Track job click
export const trackJobClick = async (data) => {
  const { error } = await supabase.from("job_clicks").insert([
    {
      job_id: data.job_id,
      job_title: data.job_title,
      company: data.company,
      role_category: data.role_category,
      location: data.location,
      user_id: data.user_id,
    },
  ]);

  if (error) throw error;

  return { success: true };
};

// ✅ Get all clicks
export const getAllClicks = async () => {
  const { data, error } = await supabase
    .from("job_clicks")
    .select("*")
    .order("created_at", { ascending: false });

  if (error) throw error;

  return data;
};