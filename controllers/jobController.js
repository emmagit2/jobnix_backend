import { supabase } from "../config/supabase.js";

/* ─── Slug generator (no extra package needed) ───────────────────── */
function generateSlug(title, company, location, shortId) {
  const parts = [title, company ? `at-${company}` : null, location]
    .filter(Boolean)
    .join(" ");

  const base = parts
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, "")   // remove special chars
    .replace(/\s+/g, "-")           // spaces → hyphens
    .replace(/-+/g, "-")            // collapse double hyphens
    .replace(/^-|-$/g, "")          // trim edges
    .slice(0, 74);                  // leave room for shortId

  return `${base}-${shortId}`;
}

// ─── Helper: fetch full job with tags ─────────────────────────────────────────
const getFullJob = async (id) => {
  const { data: job, error } = await supabase
    .from("jobs")
    .select("*, companies(id, name, logo_url)")
    .eq("id", id)
    .single();

  if (error || !job) return null;

  const { data: tags } = await supabase
    .from("requirements_tags")
    .select("*")
    .eq("job_id", id)
    .order("sort_order");

  const requirements =
    tags && tags.length > 0
      ? tags.map(t => ({ tag: t.tag, items: t.items }))
      : (job.requirements || []);

  return {
    ...job,
    company_name: job.companies?.name || "",
    company_logo: job.companies?.logo_url || "",
    requirements,
  };
};

// ─── Helper: fetch full job by SLUG or UUID ───────────────────────────────────
const getFullJobBySlugOrId = async (slugOrId) => {
  const isUUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(slugOrId);

  const { data: job, error } = await supabase
    .from("jobs")
    .select("*, companies(id, name, logo_url)")
    .eq(isUUID ? "id" : "slug", slugOrId)
    .single();

  if (error || !job) return null;

  const { data: tags } = await supabase
    .from("requirements_tags")
    .select("*")
    .eq("job_id", job.id)
    .order("sort_order");

  const requirements =
    tags && tags.length > 0
      ? tags.map(t => ({ tag: t.tag, items: t.items }))
      : (job.requirements || []);

  return {
    ...job,
    company_name: job.companies?.name || "",
    company_logo: job.companies?.logo_url || "",
    requirements,
  };
};

// ─── Helper: sync requirements_tags rows for a job ───────────────────────────
const syncRequirementsTags = async (jobId, requirements) => {
  await supabase.from("requirements_tags").delete().eq("job_id", jobId);

  if (!requirements || requirements.length === 0) return;

  const rows = requirements
    .filter(g => g.tag?.trim() && Array.isArray(g.items) && g.items.length > 0)
    .map((g, i) => ({
      job_id: jobId,
      tag: g.tag.trim(),
      items: g.items.filter(Boolean),
      sort_order: i,
    }));

  if (rows.length > 0) {
    await supabase.from("requirements_tags").insert(rows);
  }
};

// ─── GET ALL JOBS ─────────────────────────────────────────────────────────────
export const getJobs = async (req, res) => {
  try {
    const { data: jobs, error } = await supabase
      .from("jobs")
      .select("*, companies(id, name, logo_url)")
      .order("created_date", { ascending: false });

    if (error) throw error;

    const jobIds = jobs.map(j => j.id);

    const { data: allTags } = await supabase
      .from("requirements_tags")
      .select("*")
      .in("job_id", jobIds)
      .order("sort_order");

    const tagsByJob = {};
    (allTags || []).forEach(t => {
      if (!tagsByJob[t.job_id]) tagsByJob[t.job_id] = [];
      tagsByJob[t.job_id].push({ tag: t.tag, items: t.items });
    });

    const result = jobs.map(job => ({
      ...job,
      company_name: job.companies?.name || "",
      company_logo: job.companies?.logo_url || "",
      requirements: tagsByJob[job.id]?.length > 0
        ? tagsByJob[job.id]
        : (job.requirements || []),
    }));

    res.json({ success: true, data: result });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// ─── GET JOB BY ID or SLUG ────────────────────────────────────────────────────
// Now accepts both /jobs/some-slug  AND  /jobs/uuid-uuid-uuid
export const getJobById = async (req, res) => {
  try {
    const { id } = req.params;
    const data = await getFullJobBySlugOrId(id);   // ← updated helper
    if (!data) {
      return res.status(404).json({ success: false, message: "Job not found" });
    }
    res.json({ success: true, data });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// ─── CREATE JOB ───────────────────────────────────────────────────────────────
export const createJob = async (req, res) => {
  try {
    const {
      title, company_id, location, role_category, job_type,
      description, requirements, responsibilities, benefits,
      salary_min, salary_max, salary_currency,
      apply_link, apply_email, how_to_apply, deadline,
    } = req.body;

    // ── Fetch company name for the slug ──────────────────────────────
    let companyName = "";
    if (company_id) {
      const { data: co } = await supabase
        .from("companies")
        .select("name")
        .eq("id", company_id)
        .single();
      companyName = co?.name || "";
    }

    // ── Generate unique slug ─────────────────────────────────────────
    const shortId = Math.random().toString(36).slice(2, 8); // e.g. "k3x9mz"
    const slug = generateSlug(title, companyName, location, shortId);

    const { data, error } = await supabase
      .from("jobs")
      .insert([{
        title, company_id, location, role_category, job_type,
        description,
        requirements: [],
        responsibilities,
        benefits,
        salary_min, salary_max, salary_currency,
        apply_link, apply_email, how_to_apply, deadline,
        slug,           // ← slug saved here
      }])
      .select()
      .single();

    if (error) throw error;

    await syncRequirementsTags(data.id, requirements);

    const full = await getFullJob(data.id);
    res.json({ success: true, data: full });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// ─── UPDATE JOB ───────────────────────────────────────────────────────────────
export const updateJob = async (req, res) => {
  try {
    const { id } = req.params;
    const {
      title, company_id, location, role_category, job_type,
      description, requirements, responsibilities, benefits,
      salary_min, salary_max, salary_currency,
      apply_link, apply_email, how_to_apply, deadline,
    } = req.body;

    // ── Re-generate slug on update so it stays in sync with title/location ──
    let companyName = "";
    if (company_id) {
      const { data: co } = await supabase
        .from("companies")
        .select("name")
        .eq("id", company_id)
        .single();
      companyName = co?.name || "";
    }

    // Keep the same shortId suffix by reading the existing slug
    const { data: existing } = await supabase
      .from("jobs")
      .select("slug")
      .eq("id", id)
      .single();

    // Extract the last 6-char shortId from existing slug, or make a new one
    const existingShortId = existing?.slug?.split("-").pop() || Math.random().toString(36).slice(2, 8);
    const slug = generateSlug(title, companyName, location, existingShortId);

    const { error } = await supabase
      .from("jobs")
      .update({
        title, company_id, location, role_category, job_type,
        description,
        requirements: [],
        responsibilities,
        benefits,
        salary_min, salary_max, salary_currency,
        apply_link, apply_email, how_to_apply, deadline,
        slug,           // ← slug updated here too
      })
      .eq("id", id);

    if (error) throw error;

    await syncRequirementsTags(id, requirements);

    const full = await getFullJob(id);
    res.json({ success: true, message: "Job updated successfully", data: full });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// ─── DELETE JOB ───────────────────────────────────────────────────────────────
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

// ─── TOGGLE FEATURED ──────────────────────────────────────────────────────────
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