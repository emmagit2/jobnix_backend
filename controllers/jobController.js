import { supabase } from "../config/supabase.js";
import messagingAdminDB from "../lib/messagingAdminDB.js";
import * as notificationService from "../services/notificationService.js";
import { PLANS } from "../config/plans.js";
import { findOrCreateConversation } from "../lib/conversations.js";


const INFORMAL_JOB_FEE = 1500; // NGN — flat fee to publish an informal job advert

// Table that holds each user's skills. Its "trade" column (jsonb) is a list like
// [{ trade, organisation, location, serviceArea, yearsExperience }] and is the
// ONLY skills info shown on the applicant card for informal jobs.
const SKILLS_TABLE = "user_skills";

/* ─── Slug generator (no extra package needed) ───────────────────── */
function generateSlug(title, company, location, shortId) {
  const parts = [title, company ? `at-${company}` : null, location]
    .filter(Boolean)
    .join(" ");

  const base = parts
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 74);

  return `${base}-${shortId}`;
}

// ─── Helper: fetch full job with tags ─────────────────────────────────────────
const getFullJob = async (id) => {
  const { data: job, error } = await supabase
    .from("jobs")
    .select("*")
    .eq("id", id)
    .single();

  if (error || !job) return null;

  const [withPoster] = await attachPosterInfo([job]);

  const { data: tags } = await supabase
    .from("requirements_tags")
    .select("*")
    .eq("job_id", id)
    .order("sort_order");

  const requirements =
    tags && tags.length > 0
      ? tags.map(t => ({ tag: t.tag, items: t.items }))
      : (job.requirements || []);

  return { ...withPoster, requirements };
};

// ─── Helper: fetch full job by SLUG or UUID ───────────────────────────────────
// NOTE: intentionally NOT filtered by status here — a business or admin can
// still open a pending job's detail page directly (e.g. to preview it while
// it's under review). Public discovery (the list) is what's locked down, in
// getJobs below. If you'd rather a pending/rejected job's link also 404 for
// everyone until approved, add .eq("status", "approved") right after the
// .eq(isUUID ? "id" : "slug", slugOrId) line below.
const getFullJobBySlugOrId = async (slugOrId) => {
  const isUUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(slugOrId);

  const { data: job, error } = await supabase
    .from("jobs")
    .select("*")
    .eq(isUUID ? "id" : "slug", slugOrId)
    .single();

  if (error || !job) return null;

  const [withPoster] = await attachPosterInfo([job]);

  const { data: tags } = await supabase
    .from("requirements_tags")
    .select("*")
    .eq("job_id", job.id)
    .order("sort_order");

  const requirements =
    tags && tags.length > 0
      ? tags.map(t => ({ tag: t.tag, items: t.items }))
      : (job.requirements || []);

  return { ...withPoster, requirements };
};



// same shape as getPendingJobs.
const attachPosterInfo = async (jobs) => {
  const formalIds = jobs
    .filter(j => j.work_type !== "informal" && j.company_id)
    .map(j => j.company_id);
  const informalIds = jobs
    .filter(j => j.work_type === "informal" && j.submitted_by_business_id)
    .map(j => j.submitted_by_business_id);

  let companiesById = {};
  if (formalIds.length > 0) {
    const { data } = await supabase
      .from("companies")
      .select("id, name, logo_url")
      .in("id", [...new Set(formalIds)]);
    companiesById = Object.fromEntries((data || []).map(c => [c.id, c]));
  }

  let businessesById = {};
  if (informalIds.length > 0) {
    const { data } = await supabase
      .from("business_profiles")
      // ✅ added business_type + address so the informal "Posted By" card
      // on JobDetail.jsx has something to show beyond name/logo/phone.
      .select("id, business_name, owner_name, logo_url, phone, phone_verified, nin_verified, business_type, address")
      .in("id", [...new Set(informalIds)]);
    businessesById = Object.fromEntries((data || []).map(b => [b.id, b]));
  }

  return jobs.map(job => {
    if (job.work_type === "informal") {
      const biz = businessesById[job.submitted_by_business_id];
      return {
        ...job,
        company_name: biz?.business_name || biz?.owner_name || "Individual",
        company_logo: biz?.logo_url || "",
        poster: biz || null,
      };
    }
    const co = companiesById[job.company_id];
    return {
      ...job,
      company_name: co?.name || "",
      company_logo: co?.logo_url || "",
    };
  });
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

// ─── Helper: resolve which account (if any) owns a job, for notifications/
// messaging. A job belongs to whoever `recruiter_email` matches — either a
// real business/corporate account, or an unclaimed guest recruiter until
// they sign up (mirrors your existing guest-merge flow). ────────────────────
const resolveBusinessIdForJob = async (job) => {
  if (!job.recruiter_email) return null;
  const email = job.recruiter_email.toLowerCase();

  const { data: account } = await supabase
    .from("profiles")
    .select("id")
    .ilike("email", email)
    .in("account_type", ["business", "corporate"])
    .maybeSingle();
  if (account) return account.id;

  const { data: guest } = await supabase
    .from("recruiter_guests")
    .select("merged_user_id")
    .ilike("email", email)
    .maybeSingle();
  return guest?.merged_user_id || null;
};

// ─── GET ALL JOBS ─────────────────────────────────────────────────────────────
// .eq("status", "approved") keeps pending/rejected informal submissions out
// of the public listing. Formal/admin/scraped jobs default to "approved"
// automatically (the migration's column default), so nothing that used to
// show up here disappears.
export const getJobs = async (req, res) => {
  try {
    const { data: jobs, error } = await supabase
      .from("jobs")
      .select("*")
      .eq("status", "approved")
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

    const withPoster = await attachPosterInfo(jobs);

    const result = withPoster.map(job => ({
      ...job,
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
export const getJobById = async (req, res) => {
  try {
    const { id } = req.params;
    const data = await getFullJobBySlugOrId(id);
    if (!data) {
      return res.status(404).json({ success: false, message: "Job not found" });
    }
    res.json({ success: true, data });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// ─── CREATE JOB (formal / admin / scraped — goes live immediately) ───────────
export const createJob = async (req, res) => {
  try {
    const {
      title, company_id: rawCompanyId, location, role_category, job_type,
      work_type, // ✅ 'formal' | 'informal'
      description, requirements, responsibilities, benefits,
      salary_min, salary_max, salary_currency,
      apply_method, // ✅ 'platform' | 'email' | 'instructions'
      apply_link, apply_email, how_to_apply, deadline,
      recruiter_email, // ✅ client/recruiter contact — only meaningful when apply_method === 'platform'
    } = req.body;

    // ✅ work_type is required and must be exactly formal or informal —
    // matches the DB check constraint, but validate here too for a clean 400
    // instead of a raw Postgres constraint error.
    if (!work_type || !["formal", "informal"].includes(work_type)) {
      return res.status(400).json({ success: false, message: "work_type must be 'formal' or 'informal'" });
    }

    // ✅ recruiter_email is required for one-click jobs — mirrors the check
    // in getOrCreateRecruiterLink, so a job can't end up postable without one
    // and only fail later when someone tries to generate a link.
    if (apply_method === "platform" && !recruiter_email) {
      return res.status(400).json({ success: false, message: "recruiter_email is required for one-click apply jobs" });
    }

    // ── Free/Premium plan job-count limit ────────────────────────────
    // Only enforced when the poster has a business_profiles row (i.e. is a
    // logged-in business account, not a guest/email-only recruiter). Remove
    // this block if you don't want server-side plan enforcement here.
    if (req.businessId) {
      const { data: business } = await supabase
        .from("business_profiles")
        .select("plan")
        .eq("id", req.businessId)
        .maybeSingle();

      if (business) {
        const plan = PLANS[business.plan] || PLANS.free;
        const today = new Date().toISOString().slice(0, 10);
        const { count } = await supabase
          .from("jobs")
          .select("id", { count: "exact", head: true })
          .ilike("recruiter_email", recruiter_email || "")
          .gte("deadline", today);

        if ((count || 0) >= plan.maxActiveJobs) {
          return res.status(403).json({
            success: false,
            message: `Your ${plan.label} plan allows up to ${plan.maxActiveJobs} active job(s). Upgrade to Premium to post more.`,
            code: "PLAN_LIMIT_REACHED",
          });
        }
      }
    }

    // ✅ Strip "__other__" sentinel — store null instead
    const company_id = (rawCompanyId && rawCompanyId !== "__other__") ? rawCompanyId : null;

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
    const shortId = Math.random().toString(36).slice(2, 8);
    const slug = generateSlug(title, companyName, location, shortId);

    const { data, error } = await supabase
      .from("jobs")
      .insert([{
        title, company_id, location, role_category, job_type,
        work_type,
        description,
        requirements: [],
        responsibilities,
        benefits,
        salary_min, salary_max, salary_currency,
        apply_method,
        apply_link, apply_email, how_to_apply, deadline,
        // ✅ Only ever store an email here for one-click jobs — null it out
        // for email/instructions jobs even if the client sent a stray value.
        recruiter_email: apply_method === "platform" ? recruiter_email : null,
        slug,
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
      title, company_id: rawCompanyId, location, role_category, job_type,
      work_type, // ✅ 'formal' | 'informal'
      description, requirements, responsibilities, benefits,
      salary_min, salary_max, salary_currency,
      apply_method, // ✅ 'platform' | 'email' | 'instructions'
      apply_link, apply_email, how_to_apply, deadline,
      recruiter_email, // ✅ client/recruiter contact — only meaningful when apply_method === 'platform'
    } = req.body;

    // ✅ Same validation as createJob — required, exactly formal or informal.
    if (!work_type || !["formal", "informal"].includes(work_type)) {
      return res.status(400).json({ success: false, message: "work_type must be 'formal' or 'informal'" });
    }

    // ✅ Same recruiter_email requirement as createJob.
    if (apply_method === "platform" && !recruiter_email) {
      return res.status(400).json({ success: false, message: "recruiter_email is required for one-click apply jobs" });
    }

    // ✅ Strip "__other__" sentinel — store null instead
    const company_id = (rawCompanyId && rawCompanyId !== "__other__") ? rawCompanyId : null;

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

    const existingShortId = existing?.slug?.split("-").pop() || Math.random().toString(36).slice(2, 8);
    const slug = generateSlug(title, companyName, location, existingShortId);

    const { error } = await supabase
      .from("jobs")
      .update({
        title, company_id, location, role_category, job_type,
        work_type,
        description,
        requirements: [],
        responsibilities,
        benefits,
        salary_min, salary_max, salary_currency,
        apply_method,
        apply_link, apply_email, how_to_apply, deadline,
        // ✅ Only ever store an email here for one-click jobs — null it out
        // if the job is switched to email/instructions on this update.
        recruiter_email: apply_method === "platform" ? recruiter_email : null,
        slug,
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

// ═══════════════════════════════════════════════════════════════════════════
// Job analytics (views/clicks/applications), applying, and the
// business-dashboard "my jobs with stats" endpoints. Needs the migration in
// supabase/migration_addon.sql run first (adds view_count/click_count/
// application_count/deadline_notified_at to jobs, plus the applications table
// and increment_job_view/click/application RPC functions).
// ═══════════════════════════════════════════════════════════════════════════

// ─── VIEW (public): job seeker opens a job's detail page ─────────────────────
export const incrementJobView = async (req, res) => {
  try {
    const { data, error } = await supabase.rpc("increment_job_view", { p_job_id: req.params.id });
    if (error) throw error;
    const job = data?.[0];
    if (!job) return res.status(404).json({ success: false, message: "Job not found" });
    res.json({ success: true, data: job });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// ─── CLICK (public): job seeker clicks "Apply" / the job card ────────────────
export const incrementJobClick = async (req, res) => {
  try {
    const { data, error } = await supabase.rpc("increment_job_click", { p_job_id: req.params.id });
    if (error) throw error;
    const job = data?.[0];
    if (!job) return res.status(404).json({ success: false, message: "Job not found" });
    res.json({ success: true, data: { clickCount: job.click_count } });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};


// ─── APPLY (requires a logged-in jobseeker — req.userId from requireAuth) ────
export const applyToJob = async (req, res) => {
  try {
    const { coverNote } = req.body;
    const { id: jobId } = req.params;
 
    const { data: job, error: jobErr } = await supabase.from("jobs").select("*").eq("id", jobId).maybeSingle();
    if (jobErr) throw jobErr;
    if (!job) return res.status(404).json({ success: false, message: "Job not found" });
 
    const { data: already } = await supabase
      .from("applications")
      .select("id")
      .eq("job_id", jobId)
      .eq("applicant_id", req.userId)
      .maybeSingle();
    if (already) return res.status(409).json({ success: false, message: "You've already applied to this job" });
 
    const { data: application, error: appErr } = await supabase
      .from("applications")
      .insert({ job_id: jobId, applicant_id: req.userId, cover_note: coverNote })
      .select()
      .single();
    if (appErr) throw appErr;
 
    await supabase.rpc("increment_job_application", { p_job_id: jobId });
 
    // Non-fatal: the application is already saved, so a messaging/notification
    // problem must not make the applicant see an error.
    try {
      const businessId = await resolveBusinessIdForJob(job);
      // businessId null = job posted by a guest recruiter with no account yet — nothing to notify
      if (businessId) {
        // Syncs both users into DB2, then finds or creates the conversation
        // and tags it with this job.
        const { conversationId, applicantName } = await findOrCreateConversation({
          businessId,
          applicantId: req.userId,
          jobId: job.id,
        });
 
        const { error: msgErr } = await messagingAdminDB.from("messages").insert({
          conversation_id: conversationId,
          sender_id: req.userId,
          content: coverNote?.trim() || `${applicantName} applied to "${job.title}".`,
        });
        if (msgErr) throw msgErr;
        // last_message_at is kept current by your existing
        // trg_bump_conversation_last_message trigger — no manual update needed.
 
        await notificationService.notifyNewApplicant(businessId, job.title, applicantName);
      }
    } catch (chatErr) {
      console.error("applyToJob: post-apply chat/notify failed:", chatErr.message);
    }
 
    res.status(201).json({ success: true, data: application });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};
 


// ─── JOB STATS (business dashboard): one job's view/click/application card ───
export const getJobStats = async (req, res) => {
  try {
    const { id } = req.params;

    const { data: me, error: meErr } = await supabase.from("profiles").select("email").eq("id", req.businessId).single();
    if (meErr) throw meErr;

    const { data: job, error } = await supabase
      .from("jobs")
      .select("title, recruiter_email, view_count, click_count, application_count")
      .eq("id", id)
      .maybeSingle();
    if (error) throw error;
    if (!job || (job.recruiter_email || "").toLowerCase() !== (me.email || "").toLowerCase()) {
      return res.status(404).json({ success: false, message: "Job not found" });
    }

    res.json({
      success: true,
      data: {
        title: job.title,
        viewCount: job.view_count,
        clickCount: job.click_count,
        applicationCount: job.application_count,
      },
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// ─── APPLICANTS (business dashboard): who applied to one of my jobs ──────────
// Confirms the requester owns this job (same recruiter_email check as
// getJobStats), then returns every application with the applicant's
// name/email/CV attached.
export const getJobApplicants = async (req, res) => {
  try {
    const { id } = req.params;

    const { data: me, error: meErr } = await supabase.from("profiles").select("email").eq("id", req.businessId).single();
    if (meErr) throw meErr;

    const { data: job, error: jobErr } = await supabase
      .from("jobs")
      .select("id, title, recruiter_email")
      .eq("id", id)
      .maybeSingle();
    if (jobErr) throw jobErr;
    if (!job || (job.recruiter_email || "").toLowerCase() !== (me.email || "").toLowerCase()) {
      return res.status(404).json({ success: false, message: "Job not found" });
    }

    const { data: applications, error: appsErr } = await supabase
      .from("applications")
      .select("*")
      .eq("job_id", id)
      .order("created_at", { ascending: false });
    if (appsErr) throw appsErr;

    const applicantIds = applications.map((a) => a.applicant_id);
    let byId = {};
    if (applicantIds.length > 0) {
      const { data: profiles, error: profErr } = await supabase
        .from("user_profiles")
        .select("id, full_name, email, cv_url")
        .in("id", applicantIds);
      if (profErr) throw profErr;
      byId = Object.fromEntries(profiles.map((p) => [p.id, p]));
    }

    const data = applications.map((a) => ({ ...a, applicant: byId[a.applicant_id] || null }));

    res.json({ success: true, data });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// ═══════════════════════════════════════════════════════════════════════════
// Informal job submission (business/agent), admin approval queue, and
// payment confirmation. Needs jobs_approval_agent_payment_migration.sql run
// first (adds status, submitted_by_business_id, approved_by/approved_at,
// posted_by_type, agent_name/agent_phone, agent_liability_accepted(+at),
// payment_status/payment_amount/payment_reference/paid_at to "jobs").
// ═══════════════════════════════════════════════════════════════════════════

// ─── CREATE INFORMAL JOB (business or agent submits — goes to "pending") ─────
// Separate from createJob (which stays as-is for formal/admin/scraped jobs).
// A business's informal submission is NEVER auto-approved and NEVER goes
// live before payment is confirmed AND an admin approves it.
export const submitInformalJob = async (req, res) => {
  try {
    const {
      title, location, role_category, description, responsibilities, benefits,
      salary_min, salary_max, salary_currency,
      deadline,
      postAs, // 'owner' | 'agent'
      agent_name, agent_phone, // only meaningful when postAs === 'agent'
    } = req.body;

    if (!req.businessId) {
      return res.status(401).json({ success: false, message: "Must be logged in as a business to submit a job" });
    }

    const isAgent = postAs === "agent";
    if (isAgent && (!agent_name || !agent_phone)) {
      return res.status(400).json({ success: false, message: "Agent name and phone are required when posting as an agent" });
    }

    const shortId = Math.random().toString(36).slice(2, 8);
    const slug = generateSlug(title, "", location, shortId);

    const { data, error } = await supabase
      .from("jobs")
      .insert([{
        title, location, role_category,
        work_type: "informal",
        job_type: "Full-time",
        description,
        requirements: [],
        responsibilities: responsibilities || [],
        benefits: benefits || [],
        salary_min, salary_max, salary_currency,

        // Informal jobs are always one-click. These are set here on the
        // server so the client can't send anything else.
        apply_method: "platform",
        apply_link: null,
        apply_email: null,
        how_to_apply: null,
        recruiter_email: null,
        deadline,
        slug,

        // Approval — pending until admin reviews
        status: "pending",
        submitted_by_business_id: req.businessId,

        // Agent
        posted_by_type: isAgent ? "agent" : "owner",
        agent_name: isAgent ? agent_name : null,
        agent_phone: isAgent ? agent_phone : null,
        agent_liability_accepted: isAgent,
        agent_liability_accepted_at: isAgent ? new Date().toISOString() : null,

        // Payment — required before the job can go live
        payment_status: "pending",
        payment_amount: INFORMAL_JOB_FEE,
        payment_currency: "NGN",
      }])
      .select()
      .single();

    if (error) throw error;
    res.status(201).json({ success: true, data, message: "Job submitted — pending approval and payment." });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// ─── CONFIRM PAYMENT (call from your payment provider's webhook, not the client) ─
// ⚠️ This route currently has no signature/auth check in the router file —
// lock it down with your provider's webhook signature verification before
// going live, or anyone who knows a job's id could call it and fake a paid
// status without actually paying.
export const confirmInformalJobPayment = async (req, res) => {
  try {
    const { id } = req.params;
    const { paymentReference } = req.body;

    const { data, error } = await supabase
      .from("jobs")
      .update({
        payment_status: "paid",
        payment_reference: paymentReference,
        paid_at: new Date().toISOString(),
      })
      .eq("id", id)
      .select()
      .single();
    if (error) throw error;

    res.json({ success: true, data, message: "Payment confirmed — job is now awaiting admin approval." });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// ─── ADMIN: LIST PENDING INFORMAL JOBS ───────────────────────────────────────
export const getPendingJobs = async (req, res) => {
  try {
    const { data: jobs, error } = await supabase
      .from("jobs")
      .select("*")
      .eq("work_type", "informal")
      .eq("status", "pending")
      .eq("payment_status", "paid")
      .order("created_date", { ascending: true });

    if (error) throw error;

    const businessIds = [...new Set(jobs.map(j => j.submitted_by_business_id).filter(Boolean))];
    let posterById = {};
    if (businessIds.length > 0) {
      const { data: businesses, error: bizErr } = await supabase
        .from("business_profiles")
        .select("id, business_name, owner_name, phone, phone_verified, nin_verified, logo_url")
        .in("id", businessIds);
      if (bizErr) throw bizErr;
      posterById = Object.fromEntries(businesses.map(b => [b.id, b]));
    }

    const data = jobs.map(job => ({
      ...job,
      poster: posterById[job.submitted_by_business_id] || null,
    }));

    res.json({ success: true, data });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// ─── ADMIN: APPROVE ───────────────────────────────────────────────────────────
export const approveJob = async (req, res) => {
  try {
    const { id } = req.params;

    const { data: job, error: fetchErr } = await supabase
      .from("jobs")
      .select("title, payment_status, submitted_by_business_id")
      .eq("id", id)
      .single();
    if (fetchErr) throw fetchErr;

    if (job.payment_status !== "paid") {
      return res.status(400).json({ success: false, message: "Cannot approve a job that hasn't been paid for" });
    }

    const { data, error } = await supabase
      .from("jobs")
      .update({
        status: "approved",
        approved_by: req.userId,
        approved_at: new Date().toISOString(),
      })
      .eq("id", id)
      .select()
      .single();
    if (error) throw error;

    // Notifications not wired up yet — don't let a missing/broken notifier
    // block the actual approval. Remove this try/catch once
    // notifyJobApproved is implemented and tested.
    if (job.submitted_by_business_id && typeof notificationService.notifyJobApproved === "function") {
      try {
        await notificationService.notifyJobApproved(job.submitted_by_business_id, job.title);
      } catch (notifyErr) {
        console.error("notifyJobApproved failed (non-fatal):", notifyErr.message);
      }
    }

    res.json({ success: true, data, message: "Job approved and now live" });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// ─── ADMIN: REJECT ────────────────────────────────────────────────────────────
export const rejectJob = async (req, res) => {
  try {
    const { id } = req.params;
    const { reason } = req.body;

    const { data: job, error: fetchErr } = await supabase
      .from("jobs")
      .select("title, submitted_by_business_id")
      .eq("id", id)
      .single();
    if (fetchErr) throw fetchErr;

    const { data, error } = await supabase
      .from("jobs")
      .update({ status: "rejected", rejection_reason: reason || null })
      .eq("id", id)
      .select()
      .single();
    if (error) throw error;

    if (job.submitted_by_business_id && typeof notificationService.notifyJobRejected === "function") {
      try {
        await notificationService.notifyJobRejected(job.submitted_by_business_id, job.title, reason || null);
      } catch (notifyErr) {
        console.error("notifyJobRejected failed (non-fatal):", notifyErr.message);
      }
    }

    res.json({ success: true, data, message: "Job rejected" });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

export const getMyJobs = async (req, res) => {
  try {
    const { data: me, error: meErr } = await supabase.from("profiles").select("email").eq("id", req.businessId).single();
    if (meErr) throw meErr;

    const { data, error } = await supabase
      .from("jobs")
      .select("*, companies(id, name, logo_url)")
      .or(`recruiter_email.ilike.${me.email},submitted_by_business_id.eq.${req.businessId}`)
      .order("created_date", { ascending: false });
    if (error) throw error;

    res.json({ success: true, data });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// ═══════════════════════════════════════════════════════════════════════════
// Business dashboard: applicants to MY informal jobs
// (powers Applicants.jsx — list, accept/reject, and open an in-app chat)
// ═══════════════════════════════════════════════════════════════════════════

// jsonb columns come back already parsed, but if a column is plain text this
// turns it into real data instead of crashing.
const parseJsonValue = (v, fallback) => {
  if (v == null) return fallback;
  if (typeof v === "string") {
    try { return JSON.parse(v); } catch { return fallback; }
  }
  return v;
};

const cleanText = (v) => (v == null ? "" : String(v).trim());

// user_skills.trade (jsonb) -> [{ trade, organisation, location, service_area, years }]
// This is the only skills info sent for informal applicants.
const toTradeList = (raw) => {
  const list = parseJsonValue(raw, []);
  if (!Array.isArray(list)) return [];
  return list
    .map((t) => ({
      trade: cleanText(t?.trade),
      organisation: cleanText(t?.organisation),
      location: cleanText(t?.location),
      service_area: cleanText(t?.serviceArea),
      years: Number(t?.yearsExperience) || 0,
    }))
    .filter((t) => t.trade);
};

// ─── All applicants across MY informal jobs ──────────────────────────────────
// Returns the job (title, location), when they applied, where they said they
// were when they applied, their work status, and their trade (from
// user_skills.trade). Phone, email, CV, headline, roles and the technical /
// soft skill lists are deliberately NOT sent, so businesses reach applicants
// through in-app Messages only.
export const getMyInformalApplicants = async (req, res) => {
  try {
    const { data: jobs, error: jobsErr } = await supabase
      .from("jobs")
      .select("id, title, location, role_category")
      .eq("work_type", "informal")
      .eq("submitted_by_business_id", req.businessId);
    if (jobsErr) throw jobsErr;
    if (!jobs.length) return res.json({ success: true, data: [] });

    const jobById = Object.fromEntries(jobs.map((j) => [j.id, j]));

    // Also reads the location the applicant shared in the
    // "Where are you right now?" popup
    const { data: apps, error: appsErr } = await supabase
      .from("applications")
      .select("id, job_id, applicant_id, status, applied_at, applicant_location, applicant_lat, applicant_lng")
      .in("job_id", jobs.map((j) => j.id))
      .order("applied_at", { ascending: false });
    if (appsErr) throw appsErr;

    const ids = [...new Set(apps.map((a) => a.applicant_id))];
    let byId = {};
    let skillsByUser = {};

    if (ids.length) {
      const { data: profiles, error: profErr } = await supabase
        .from("user_profiles")
        .select("id, full_name, avatar_url, location, job_locations, employment_status")
        .in("id", ids);
      if (profErr) throw profErr;
      byId = Object.fromEntries(profiles.map((p) => [p.id, p]));

      // Only the "trade" column. Non-fatal: if this lookup fails, the page
      // still works, just without the trade section.
      const { data: skillRows, error: skillErr } = await supabase
        .from(SKILLS_TABLE)
        .select("user_id, trade")
        .in("user_id", ids);
      if (skillErr) {
        console.error(`Skills lookup failed (check SKILLS_TABLE = "${SKILLS_TABLE}"):`, skillErr.message);
      } else {
        skillsByUser = Object.fromEntries((skillRows || []).map((r) => [r.user_id, r]));
      }
    }

    const data = apps.map((a) => {
      const p = byId[a.applicant_id];
      const job = jobById[a.job_id];
      const skills = skillsByUser[a.applicant_id];
      return {
        id: a.id,
        status: a.status === "applied" ? "pending" : a.status,
        applied_at: a.applied_at,

        // the job they applied for
        job_id: a.job_id,
        job_title: job?.title || "",
        job_location: job?.location || "",
        job_category: job?.role_category || "",

        // where the applicant said they were when they applied
        current_location: a.applicant_location || null,
        current_lat: a.applicant_lat ?? null,
        current_lng: a.applicant_lng ?? null,

        // the applicant (no contact details, no headline, no roles)
        applicant_id: a.applicant_id,
        applicant_name: p?.full_name || "Applicant",
        applicant_avatar: p?.avatar_url || null,
        applicant_location: p?.location || null, // where they LIVE (profile)
        job_locations: p?.job_locations || [],   // "Can work in"
        employment_status: p?.employment_status || null, // looking / full_time / part_time

        // from user_skills.trade
        trades: toTradeList(skills?.trade),
      };
    });

    res.json({ success: true, data });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// ─── Accept / reject / reset one applicant ───────────────────────────────────
export const updateApplicantStatus = async (req, res) => {
  try {
    const { applicationId } = req.params;
    const dbStatus = { pending: "applied", accepted: "accepted", rejected: "rejected" }[req.body.status];
    if (!dbStatus) {
      return res.status(400).json({ success: false, message: "status must be pending, accepted or rejected" });
    }

    const { data: app, error } = await supabase
      .from("applications")
      .select("id, jobs ( work_type, submitted_by_business_id )")
      .eq("id", applicationId)
      .maybeSingle();
    if (error) throw error;

    // 404 rather than 403 so we don't reveal that the application exists
    if (!app || app.jobs?.work_type !== "informal" || app.jobs.submitted_by_business_id !== req.businessId) {
      return res.status(404).json({ success: false, message: "Application not found" });
    }

    const { error: updErr } = await supabase.from("applications").update({ status: dbStatus }).eq("id", applicationId);
    if (updErr) throw updErr;

    res.json({ success: true, data: { id: applicationId, status: req.body.status } });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// ─── Open (or create) the in-app chat with one applicant ─────────────────────
// Same conversation pattern applyToJob uses: one conversation per pair of
// people, tagged with the job it started from.
export const openApplicantChat = async (req, res) => {
  try {
    const { applicationId } = req.params;
    const businessId = req.businessId;

    const { data: app, error } = await supabase
      .from("applications")
      .select("id, applicant_id, job_id, jobs ( id, work_type, submitted_by_business_id )")
      .eq("id", applicationId)
      .maybeSingle();
    if (error) throw error;

    if (!app || app.jobs?.work_type !== "informal" || app.jobs.submitted_by_business_id !== businessId) {
      return res.status(404).json({ success: false, message: "Application not found" });
    }

    const { conversationId } = await findOrCreateConversation({
      businessId, applicantId: app.applicant_id, jobId: app.job_id,
    });

    res.json({ success: true, data: { conversation_id: conversationId, applicant_id: app.applicant_id } });
  } catch (err) {
    console.error("openApplicantChat failed:", err);
    res.status(500).json({ success: false, message: err.message });
  }
};
// ═══════════════════════════════════════════════════════════════════════════
// ADD THIS to controllers/jobs.controller.js — new export, nothing else in
// that file needs to change. Place it near getMyInformalApplicants, since it
// uses the exact same ownership check.
//
// Informal-jobs-only: ownership here is submitted_by_business_id alone —
// same as getMyInformalApplicants. Formal jobs are NOT included.
// ═══════════════════════════════════════════════════════════════════════════

// ─── BUSINESS DASHBOARD: analytics for MY informal jobs ──────────────────────
// Views/clicks/applications per job, plus where applicants said they were
// when they applied (applications.applicant_location — captured only for
// informal jobs; see createApplication in applications.controller.js).
// Jobnix doesn't track page-view geography per business (that only exists
// platform-wide, in the admin dashboard's separate click-tracking table), so
// this reports "applicants by area", not "views by area" — accurate to what
// the data actually is.
export const getMyInformalJobsAnalytics = async (req, res) => {
  try {
    const { data: jobs, error: jobsErr } = await supabase
      .from("jobs")
      .select("id, title, role_category, location, status, view_count, click_count, application_count, created_date")
      .eq("work_type", "informal")
      .eq("submitted_by_business_id", req.businessId)
      .order("created_date", { ascending: false });
    if (jobsErr) throw jobsErr;

    const jobIds = jobs.map((j) => j.id);

    let locationsByJob = {};
    if (jobIds.length > 0) {
      const { data: apps, error: appsErr } = await supabase
        .from("applications")
        .select("job_id, applicant_location")
        .in("job_id", jobIds)
        .not("applicant_location", "is", null);
      if (appsErr) throw appsErr;

      apps.forEach((a) => {
        const loc = (a.applicant_location || "").trim();
        if (!loc) return;
        if (!locationsByJob[a.job_id]) locationsByJob[a.job_id] = {};
        locationsByJob[a.job_id][loc] = (locationsByJob[a.job_id][loc] || 0) + 1;
      });
    }

    const data = jobs.map((j) => {
      const locCounts = locationsByJob[j.id] || {};
      const applicant_locations = Object.entries(locCounts)
        .map(([location, count]) => ({ location, count }))
        .sort((a, b) => b.count - a.count);

      return {
        id: j.id,
        title: j.title,
        role_category: j.role_category,
        location: j.location,
        status: j.status,
        views: j.view_count || 0,
        clicks: j.click_count || 0,
        applicant_count: j.application_count || 0,
        applicant_locations, // [{ location, count }]
      };
    });

    return res.json({ success: true, data });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};
