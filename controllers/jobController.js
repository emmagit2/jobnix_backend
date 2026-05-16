import { supabase } from "../config/supabase.js";

export const getJobs = async (req, res) => {
  try {
    const { data, error } = await supabase
      .from("jobs")
      .select(`*, companies(id, name, logo_url)`)
      .order("created_date", { ascending: false });

    if (error) throw error;

    const jobs = data.map(job => ({
      ...job,
      company_name: job.companies?.name || "",
      company_logo: job.companies?.logo_url || "",
    }));

    res.json({ success: true, data: jobs });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

export const getJobById = async (req, res) => {
  try {
    const { id } = req.params;

    const { data, error } = await supabase
      .from("jobs")
      .select(`*, companies(id, name, logo_url)`)
      .eq("id", id)
      .single();

    if (error || !data) {
      return res.status(404).json({ success: false, message: "Job not found" });
    }

    res.json({
      success: true,
      data: {
        ...data,
        company_name: data.companies?.name || "",
        company_logo: data.companies?.logo_url || "",
      },
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

export const createJob = async (req, res) => {
  try {
    const {
      title, company_id, location, role_category, job_type,
      description, requirements, responsibilities, benefits,
      salary_min, salary_max, salary_currency, apply_link, deadline,
    } = req.body;

    const { data, error } = await supabase
      .from("jobs")
      .insert([{
        title, company_id, location, role_category, job_type,
        description, requirements, responsibilities, benefits,
        salary_min, salary_max, salary_currency, apply_link, deadline,
      }])
      .select();

    if (error) throw error;

    res.json({ success: true, data: data[0] });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

export const updateJob = async (req, res) => {
  try {
    const { id } = req.params;

    const {
      title, company_id, location, role_category, job_type,
      description, requirements, responsibilities, benefits,
      salary_min, salary_max, salary_currency, apply_link,
      deadline, is_featured,
    } = req.body;

    const { data, error } = await supabase
      .from("jobs")
      .update({
        title, company_id, location, role_category, job_type,
        description, requirements, responsibilities, benefits,
        salary_min, salary_max, salary_currency, apply_link,
        deadline, is_featured,
      })
      .eq("id", id)
      .select();

    if (error) throw error;

    res.json({ success: true, message: "Job updated successfully", data: data[0] });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

export const deleteJob = async (req, res) => {
  try {
    const { id } = req.params;

    const { error } = await supabase.from("jobs").delete().eq("id", id);

    if (error) throw error;

    res.json({ success: true, message: "Job deleted successfully" });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

export const toggleFeaturedJob = async (req, res) => {
  try {
    const { id } = req.params;

    const { data: existingJob, error: fetchError } = await supabase
      .from("jobs")
      .select("is_featured")
      .eq("id", id)
      .single();

    if (fetchError) throw fetchError;

    const { data, error } = await supabase
      .from("jobs")
      .update({ is_featured: !existingJob.is_featured })
      .eq("id", id)
      .select();

    if (error) throw error;

    res.json({ success: true, message: "Featured status updated", data });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};