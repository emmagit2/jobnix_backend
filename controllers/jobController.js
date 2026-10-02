import { supabase } from "../config/supabase.js";
import messagingAdminDB from "../lib/messagingAdminDB.js";
import * as notificationService from "../services/notificationService.js";
import { PLANS } from "../config/plans.js";
import { findOrCreateConversation } from "../lib/conversations.js";
import { sendEmail } from "../lib/email.js";
import { candidateApplicationEmail } from "../lib/emailTemplates.js";

const INFORMAL_JOB_FEE = 1500; // NGN — flat fee to publish an informal job advert
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
    if (!data || data.status === "draft") {
      return res.status(404).json({ success: false, message: "Job not found" });
    }
    res.json({ success: true, data });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

const APPLY_METHODS = ["platform", "email", "link"];

const validateApply = ({ apply_method, apply_email, apply_link, recruiter_email }) => {
  if (!APPLY_METHODS.includes(apply_method)) {
    return "Choose how candidates apply: one-click, email, or company website link.";
  }
  if (apply_method === "email" && !apply_email) return "An apply email is required for email applications.";
  if (apply_method === "link" && !apply_link) return "A website link is required for company website applications.";
  if (apply_method === "platform" && !recruiter_email) return "recruiter_email is required for one-click apply jobs.";
  return null;
};

// Builds the apply-related columns so create and update behave identically
const applyFields = ({ apply_method, apply_email, apply_link, recruiter_email, how_to_apply }) => ({
  apply_method,
  apply_link: apply_method === "link" ? apply_link : null,
  apply_email: apply_method === "email" ? apply_email : null,
  recruiter_email: apply_method === "platform" ? recruiter_email : null,
  how_to_apply: how_to_apply || null,
});

// ─── CREATE JOB (formal / admin / scraped — goes live immediately) ───────────
export const createJob = async (req, res) => {
  try {
    const {
      title, company_id: rawCompanyId, location, role_category, job_type,
      work_type, // 'formal' | 'informal'
      description, requirements, responsibilities, benefits,
      salary_min, salary_max, salary_currency,
      deadline,
      recruiter_email,
    } = req.body;

    if (!work_type || !["formal", "informal"].includes(work_type)) {
      return res.status(400).json({ success: false, message: "work_type must be 'formal' or 'informal'" });
    }

    const applyErr = validateApply(req.body);
    if (applyErr) return res.status(400).json({ success: false, message: applyErr });

    // ── Free/Premium plan job-count limit (only for logged-in business posters) ──
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

    // Strip "__other__" sentinel — store null instead
    const company_id = (rawCompanyId && rawCompanyId !== "__other__") ? rawCompanyId : null;

    let companyName = "";
    if (company_id) {
      const { data: co } = await supabase.from("companies").select("name").eq("id", company_id).single();
      companyName = co?.name || "";
    }

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
        ...applyFields(req.body),
        deadline,
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
      work_type,
      description, requirements, responsibilities, benefits,
      salary_min, salary_max, salary_currency,
      deadline,
    } = req.body;

    if (!work_type || !["formal", "informal"].includes(work_type)) {
      return res.status(400).json({ success: false, message: "work_type must be 'formal' or 'informal'" });
    }

    const applyErr = validateApply(req.body);
    if (applyErr) return res.status(400).json({ success: false, message: applyErr });

    const company_id = (rawCompanyId && rawCompanyId !== "__other__") ? rawCompanyId : null;

    let companyName = "";
    if (company_id) {
      const { data: co } = await supabase.from("companies").select("name").eq("id", company_id).single();
      companyName = co?.name || "";
    }

    // Keep the same shortId suffix so the job's URL stays recognisable
    const { data: existing } = await supabase.from("jobs").select("slug").eq("id", id).single();
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
        ...applyFields(req.body),
        deadline,
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
if (!job || job.status === "draft") return res.status(404).json({ success: false, message: "Job not found" });
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

// ─── Save the uploaded CV path to the user's profile ─────────────────────────
export const saveMyCv = async (req, res) => {
  try {
    const { cvPath } = req.body;
    const userId = req.userId || req.user?.id;

    // The path must live inside the user's own folder in the bucket
    if (!cvPath || typeof cvPath !== "string" || !cvPath.startsWith(`${userId}/`)) {
      return res.status(400).json({ success: false, message: "Invalid CV path" });
    }

    const { data, error } = await supabase
      .from("user_profiles")
      .update({ cv_url: cvPath, cv_uploaded: true })
      .eq("id", userId)
      .select("id");
    if (error) throw error;

    // No profile row yet: create a minimal one so the CV has somewhere to live
    if (!data?.length) {
      const { data: authUser } = await supabase.auth.admin.getUserById(userId);
      const { error: insErr } = await supabase.from("user_profiles").insert({
        id: userId,
        email: authUser?.user?.email || null,
        full_name: authUser?.user?.user_metadata?.full_name || null,
        cv_url: cvPath,
        cv_uploaded: true,
      });
      if (insErr) throw insErr;
    }

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};
 
// ═══════════════════════════════════════════════════════════════════════════
// APPLY BY EMAIL — server sends the branded email to the job's apply_email,
// with the applicant's CV attached (or a CV / profile link as a fallback).
// Needs: sendEmail (lib/email.js) and candidateApplicationEmail
// (lib/emailTemplates.js) imported at the top of this file.
// ═══════════════════════════════════════════════════════════════════════════

 const CV_BUCKET = "cvs"; // 👈 change to your real bucket name

async function fetchCvAttachment(cvPath, applicantName) {
  try {
    const { data: blob, error } = await supabase.storage.from(CV_BUCKET).download(cvPath);
    if (error || !blob) return null;

    const buf = Buffer.from(await blob.arrayBuffer());
    if (buf.length > 5 * 1024 * 1024) return null; // skip attaching CVs over 5 MB
    const ext = (cvPath.split(".").pop() || "pdf").toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 5) || "pdf";
    const safeName = applicantName.replace(/[^a-z0-9]+/gi, "_").replace(/^_|_$/g, "") || "Applicant";
    return { filename: `${safeName}_CV.${ext}`, content: buf };
  } catch {
    return null;
  }
}

export const applyByEmail = async (req, res) => {
  try {
    const { id: jobId } = req.params;

  const { data: job, error: jobErr } = await supabase
  .from("jobs").select("*").eq("id", jobId).maybeSingle();
if (jobErr) throw jobErr;
if (!job || job.status === "draft") return res.status(404).json({ success: false, message: "Job not found" });
    // Recipient always comes from the DB, never from the client
    if (job.apply_method !== "email" || !job.apply_email) {
      return res.status(400).json({ success: false, message: "This job does not accept email applications" });
    }
    if (job.deadline && new Date(job.deadline) < new Date(new Date().toDateString())) {
      return res.status(400).json({ success: false, message: "This job is no longer accepting applications" });
    }

    const { data: already } = await supabase
      .from("applications").select("id")
      .eq("job_id", jobId).eq("applicant_id", req.userId).maybeSingle();
    if (already) return res.status(409).json({ success: false, message: "You've already applied to this job" });

    // ⚠️ "username" = the column behind jobnix.ng/u/<username>. Rename if yours differs.
    const { data: profile, error: profErr } = await supabase
      .from("user_profiles")
      .select("full_name, email, cv_url, headline, username")
      .eq("id", req.userId).maybeSingle();
    if (profErr) throw profErr;


    // Must be acting as a job seeker
    const { data: me } = await supabase.from("profiles").select("account_type").eq("id", req.userId).maybeSingle();
    if (me?.account_type && me.account_type !== "jobseeker") {
      return res.status(403).json({ success: false, code: "WRONG_ACCOUNT", message: "Switch to your job seeker account to apply." });
    }

    // Can't apply to your own job
    const myEmail = (profile?.email || "").toLowerCase();
    const ownEmails = [job.apply_email, job.recruiter_email].map((e) => (e || "").toLowerCase());
    if (job.submitted_by_business_id === req.userId || (myEmail && ownEmails.includes(myEmail))) {
      return res.status(400).json({ success: false, message: "You can't apply to your own job." });
    }
    // Need at least a CV or a public profile to send the employer
    if (!profile?.cv_url && !profile?.username) {
      return res.status(400).json({ success: false, code: "NO_CV", message: "Upload your CV to your profile first" });
    }

    const [withCompany] = await attachPosterInfo([job]);
    const applicantName = profile.full_name || "Applicant";

    const attachment = profile.cv_url ? await fetchCvAttachment(profile.cv_url, applicantName) : null;
    
        // Signed link for the "View CV" fallback (valid 7 days)
    let cvLink = null;
    if (profile.cv_url) {
      const { data: signed } = await supabase.storage
        .from(CV_BUCKET)
        .createSignedUrl(profile.cv_url, 60 * 60 * 24 * 7);
      cvLink = signed?.signedUrl || null;
    }
    const { subject, html } = candidateApplicationEmail({
      jobTitle: job.title,
      companyName: withCompany.company_name,
      applicantName,
      applicantEmail: profile.email,
      headline: profile.headline,
      cvAttached: !!attachment,
      cvUrl: cvLink,
       profileUrl: profile.username ? `https://jobnix.ng/u/${profile.username}` : null,
      jobUrl: `https://jobnix.ng/jobs/${job.slug || job.id}`,
    });

    // Send FIRST. If it fails, nothing is recorded and the candidate can retry.
    try {
      await sendEmail({
        to: job.apply_email,
        replyTo: profile.email,
        subject,
        html,
        attachments: attachment ? [attachment] : [],
      });
    } catch (mailErr) {
      console.error("applyByEmail: send failed:", mailErr.message);
      return res.status(502).json({
        success: false, code: "EMAIL_FAILED",
        message: "We couldn't send your application. Please try again.",
      });
    }

    const { data: application, error: appErr } = await supabase
      .from("applications")
      .insert({
        job_id: jobId,
        applicant_id: req.userId,
        method: "email",
        email_sent_to: job.apply_email,
        email_body: `Application email sent for "${job.title}"${attachment ? " with CV attached" : ""}.`,
      })
      .select().single();

    if (appErr) console.error("applyByEmail: email sent but saving application failed:", appErr.message);
    else await supabase.rpc("increment_job_application", { p_job_id: jobId });

    res.status(201).json({ success: true, data: { cvAttached: !!attachment, application } });
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

    // ⬇️ Mark any pending referral commission tied to this job as paid,
    // now that the job it was earned from has actually been approved —
    // then notify the referrer that they've earned a confirmed commission.
    try {
      const { data: paidRows, error: refErr } = await supabase
        .from("referral_earnings")
        .update({ status: "paid", paid_at: new Date().toISOString() })
        .eq("job_id", id)
        .eq("status", "pending")
        .select("referrer_business_id, commission_amount, currency, referred_business_id");
      if (refErr) throw refErr;

      for (const row of paidRows || []) {
        const { data: referredBiz } = await supabase
          .from("business_profiles")
          .select("business_name")
          .eq("id", row.referred_business_id)
          .maybeSingle();

        if (typeof notificationService.notifyReferralCommissionEarned === "function") {
          await notificationService.notifyReferralCommissionEarned(
            row.referrer_business_id,
            referredBiz?.business_name || "a referred business",
            row.commission_amount,
            row.currency
          );
        }
      }
    } catch (refErr) {
      console.error("referral_earnings update/notify failed (non-fatal):", refErr.message);
    }

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

// ─── BUSINESS: EDIT MY INFORMAL JOB ───────────────────────────────────────────
// Ownership check mirrors getMyInformalApplicants — submitted_by_business_id
// must match the caller. If the job had already been approved and is live,
// editing it pushes it back to "pending" and clears approval — so a business
// can't silently swap in different content after admin sign-off. If you'd
// rather approved jobs stay live through an edit, drop the status/approved_by
// reset below.
export const updateInformalJob = async (req, res) => {
  try {
    const { id } = req.params;
    const {
      title, location, role_category, description, responsibilities, benefits,
      salary_min, salary_max, salary_currency, deadline,
      postAs, agent_name, agent_phone,
    } = req.body;

    if (!req.businessId) {
      return res.status(401).json({ success: false, message: "Must be logged in as a business" });
    }

    const { data: existing, error: fetchErr } = await supabase
      .from("jobs")
      .select("id, work_type, submitted_by_business_id, status, slug")
      .eq("id", id)
      .maybeSingle();
    if (fetchErr) throw fetchErr;

    // 404 rather than 403 so we don't reveal that the job exists
    if (!existing || existing.work_type !== "informal" || existing.submitted_by_business_id !== req.businessId) {
      return res.status(404).json({ success: false, message: "Job not found" });
    }

    const isAgent = postAs === "agent";
    if (isAgent && (!agent_name || !agent_phone)) {
      return res.status(400).json({ success: false, message: "Agent name and phone are required when posting as an agent" });
    }

    // Keep the same slug suffix, regenerate the readable part in case
    // title/location changed.
    const existingShortId = existing.slug?.split("-").pop() || Math.random().toString(36).slice(2, 8);
    const slug = generateSlug(title, "", location, existingShortId);

    const wasApproved = existing.status === "approved";

    const { data, error } = await supabase
      .from("jobs")
      .update({
        title, location, role_category, description,
        responsibilities: responsibilities || [],
        benefits: benefits || [],
        salary_min, salary_max, salary_currency,
        deadline,
        slug,

        posted_by_type: isAgent ? "agent" : "owner",
        agent_name: isAgent ? agent_name : null,
        agent_phone: isAgent ? agent_phone : null,
        agent_liability_accepted: isAgent ? true : existing.agent_liability_accepted,

        // Force re-review if this was already live — see comment above.
        ...(wasApproved ? { status: "pending", approved_by: null, approved_at: null } : {}),
      })
      .eq("id", id)
      .select()
      .single();
    if (error) throw error;

    res.json({
      success: true,
      data,
      message: wasApproved
        ? "Job updated — since it was already live, it's back in the review queue."
        : "Job updated.",
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// ─── BUSINESS: DELETE MY INFORMAL JOB ─────────────────────────────────────────
export const deleteInformalJob = async (req, res) => {
  try {
    const { id } = req.params;

    if (!req.businessId) {
      return res.status(401).json({ success: false, message: "Must be logged in as a business" });
    }

    const { data: existing, error: fetchErr } = await supabase
      .from("jobs")
      .select("id, work_type, submitted_by_business_id")
      .eq("id", id)
      .maybeSingle();
    if (fetchErr) throw fetchErr;

    if (!existing || existing.work_type !== "informal" || existing.submitted_by_business_id !== req.businessId) {
      return res.status(404).json({ success: false, message: "Job not found" });
    }

    const { error } = await supabase.from("jobs").delete().eq("id", id);
    if (error) throw error;

    res.json({ success: true, message: "Job deleted" });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

 

const loadDraft = async (id) => {
  const { data } = await supabase.from("jobs").select("*").eq("id", id).maybeSingle();
  return data && data.status === "draft" ? data : null;
};

// ─── SAVE DRAFT (create or update). Only a title is required. ───────────────
// First save: no `id` in the body → insert. Later saves: send the returned id.
export const saveAdminDraft = async (req, res) => {
  try {
    const {
      id, title, company_id: rawCompanyId, location, role_category, job_type,
      work_type, description, requirements, responsibilities, benefits,
      salary_min, salary_max, salary_currency, deadline,
      apply_method, apply_email, apply_link, recruiter_email, how_to_apply,
    } = req.body;

    if (!title?.trim()) {
      return res.status(400).json({ success: false, message: "Give the draft a title so you can find it later" });
    }

    let existing = null;
    if (id) {
      existing = await loadDraft(id);
      if (!existing) return res.status(404).json({ success: false, message: "Draft not found" });
    }

    const company_id = rawCompanyId && rawCompanyId !== "__other__" ? rawCompanyId : null;
    let companyName = "";
    if (company_id) {
      const { data: co } = await supabase.from("companies").select("name").eq("id", company_id).maybeSingle();
      companyName = co?.name || "";
    }

    const shortId = existing?.slug?.split("-").pop() || Math.random().toString(36).slice(2, 8);
    const slug = generateSlug(title, companyName, location, shortId);

    // No validateApply here: a draft may be half-filled. Publish validates.
    const row = {
      title: title.trim(),
      company_id,
      location: location || null,
      role_category: role_category || null,
      job_type: job_type || null,
      work_type: ["formal", "informal"].includes(work_type) ? work_type : "formal",
      description: description || null,
      requirements: [],
      responsibilities: responsibilities || [],
      benefits: benefits || [],
      salary_min: salary_min ?? null,
      salary_max: salary_max ?? null,
      salary_currency: salary_currency || "NGN",
      deadline: deadline || null,
      apply_method: APPLY_METHODS.includes(apply_method) ? apply_method : "platform",
      apply_link: apply_link || null,
      apply_email: apply_email || null,
      recruiter_email: recruiter_email || null,
      how_to_apply: how_to_apply || null,
      slug,
      status: "draft",
      ...(existing ? {} : { drafted_by: req.userId }),
    };

    const q = existing
      ? supabase.from("jobs").update(row).eq("id", existing.id)
      : supabase.from("jobs").insert([row]);
    const { data, error } = await q.select().single();
    if (error) throw error;

    await syncRequirementsTags(data.id, requirements);

    res.status(existing ? 200 : 201).json({ success: true, data: await getFullJob(data.id), message: "Draft saved" });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// ─── LIST DRAFTS ─────────────────────────────────────────────────────────────
export const getAdminDrafts = async (req, res) => {
  try {
    const { data, error } = await supabase
      .from("jobs")
      .select("id, title, location, role_category, job_type, work_type, deadline, company_id, drafted_by, created_date")
      .eq("status", "draft")
      .order("created_date", { ascending: false });
    if (error) throw error;

    const withCo = data.length ? await attachPosterInfo(data) : [];
    res.json({ success: true, data: withCo });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// ─── GET ONE DRAFT (prefill the form) ────────────────────────────────────────
export const getAdminDraftById = async (req, res) => {
  try {
    const draft = await loadDraft(req.params.id);
    if (!draft) return res.status(404).json({ success: false, message: "Draft not found" });
    res.json({ success: true, data: await getFullJob(draft.id) });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// ─── DELETE DRAFT ────────────────────────────────────────────────────────────
export const deleteAdminDraft = async (req, res) => {
  try {
    const draft = await loadDraft(req.params.id);
    if (!draft) return res.status(404).json({ success: false, message: "Draft not found" });

    await supabase.from("requirements_tags").delete().eq("job_id", draft.id);
    const { error } = await supabase.from("jobs").delete().eq("id", draft.id);
    if (error) throw error;
    res.json({ success: true, message: "Draft deleted" });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// ─── PUBLISH DRAFT → goes live immediately, like createJob ───────────────────
export const publishAdminDraft = async (req, res) => {
  try {
    const draft = await loadDraft(req.params.id);
    if (!draft) return res.status(404).json({ success: false, message: "Draft not found" });

    const required = ["title", "location", "role_category", "job_type", "description", "deadline"];
    const missing = required.filter((k) => !draft[k] || !String(draft[k]).trim());
    if (missing.length) {
      return res.status(400).json({
        success: false, code: "DRAFT_INCOMPLETE", missing,
        message: `Complete these fields before publishing: ${missing.join(", ")}`,
      });
    }

    if (new Date(draft.deadline) < new Date(new Date().toDateString())) {
      return res.status(400).json({ success: false, message: "The deadline has already passed. Update it before publishing." });
    }

    const applyErr = validateApply(draft);
    if (applyErr) return res.status(400).json({ success: false, message: applyErr });

    const now = new Date().toISOString();
    const { error } = await supabase
      .from("jobs")
      .update({
        ...applyFields(draft),
        status: "approved",
        approved_by: req.userId,
        approved_at: now,
        created_date: now, // so it sorts as new in getJobs
      })
      .eq("id", draft.id);
    if (error) throw error;

    res.json({ success: true, data: await getFullJob(draft.id), message: "Job published" });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};