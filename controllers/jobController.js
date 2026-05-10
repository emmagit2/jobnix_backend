import { supabase } from "../config/supabase.js";

// =============================
// ✅ GET ALL JOBS
// =============================
export const getJobs = async (req, res) => {
  try {
    const { data, error } = await supabase
      .from("jobs")
      .select("*")
      .order("created_date", { ascending: false });

    if (error) throw error;

    res.json({
      success: true,
      data,
    });
  } catch (err) {
    res.status(500).json({
      success: false,
      message: err.message,
    });
  }
};

// =============================
// ✅ GET SINGLE JOB (UUID)
// =============================
export const getJobById = async (req, res) => {
  try {
    const { id } = req.params;

    const { data, error } = await supabase
      .from("jobs")
      .select("*")
      .eq("id", id)
      .single();

    // 🔥 HANDLE NOT FOUND PROPERLY
    if (error || !data) {
      return res.status(404).json({
        success: false,
        message: "Job not found",
      });
    }

    res.json({
      success: true,
      data,
    });
  } catch (err) {
    res.status(500).json({
      success: false,
      message: err.message,
    });
  }
};

// =============================
// ✅ CREATE JOB
// =============================
export const createJob = async (req, res) => {
  try {
    let {
      title,
      company,
      location,
      role_category,
      job_type,
      description,
      deadline,
    } = req.body;

    // 🔥 FIX: ensure description is array
    if (!Array.isArray(description)) {
      description = [description];
    }

    const { data, error } = await supabase
      .from("jobs")
      .insert([
        {
          title,
          company,
          location,
          role_category,
          job_type,
          description,
          deadline,
        },
      ])
      .select();

    if (error) throw error;

    res.json({
      success: true,
      data,
    });
  } catch (err) {
    res.status(500).json({
      success: false,
      message: err.message,
    });
  }
};
// =============================
// ✅ UPDATE JOB
// =============================
export const updateJob = async (req, res) => {
  try {
    const { id } = req.params;

    let {
      title,
      company,
      location,
      role_category,
      job_type,
      description,
      deadline,
      is_featured,
    } = req.body;

    // 🔥 Ensure description is array
    if (!Array.isArray(description)) {
      description = [description];
    }

    const { data, error } = await supabase
      .from("jobs")
      .update({
        title,
        company,
        location,
        role_category,
        job_type,
        description,
        deadline,
        is_featured,
      })
      .eq("id", id)
      .select();

    if (error) throw error;

    res.json({
      success: true,
      message: "Job updated successfully",
      data,
    });

  } catch (err) {
    res.status(500).json({
      success: false,
      message: err.message,
    });
  }
};


// =============================
// ✅ DELETE JOB
// =============================
export const deleteJob = async (req, res) => {
  try {
    const { id } = req.params;

    const { error } = await supabase
      .from("jobs")
      .delete()
      .eq("id", id);

    if (error) throw error;

    res.json({
      success: true,
      message: "Job deleted successfully",
    });

  } catch (err) {
    res.status(500).json({
      success: false,
      message: err.message,
    });
  }
};


// =============================
// ✅ TOGGLE FEATURED
// =============================
export const toggleFeaturedJob = async (req, res) => {
  try {
    const { id } = req.params;

    // 🔥 GET CURRENT JOB
    const { data: existingJob, error: fetchError } = await supabase
      .from("jobs")
      .select("is_featured")
      .eq("id", id)
      .single();

    if (fetchError) throw fetchError;

    // 🔥 TOGGLE BOOLEAN
    const { data, error } = await supabase
      .from("jobs")
      .update({
        is_featured: !existingJob.is_featured,
      })
      .eq("id", id)
      .select();

    if (error) throw error;

    res.json({
      success: true,
      message: "Featured status updated",
      data,
    });

  } catch (err) {
    res.status(500).json({
      success: false,
      message: err.message,
    });
  }
};