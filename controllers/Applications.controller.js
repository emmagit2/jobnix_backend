// controllers/applications.controller.js
//
// Assumes: req.user is set by requireAuth (raw Supabase auth user) for
// applicant-facing routes, and by adminCheck (auth user + req.profile,
// which includes role) for admin routes. Admin routes no longer check
// req.user.role themselves — adminCheck already verified profile.role
// === "admin" before the handler runs.
//
// NOTE ON PROFILE DATA: `profiles` only holds id/email/role/account_type/
// onboarded/referral_source/cv_upload_count/match_count. Display fields
// like full_name, avatar_url, and cv_url live on `user_profiles`, which is
// linked user_profiles.id -> profiles.id. So applicant details need a
// two-level embed: applications -> profiles -> user_profiles.
//
// NOTE ON EMAILS: a job has two unrelated email fields.
//   - apply_email: applicant-facing, only used for apply_method = 'email'
//     jobs. Applicants send *their own* email there — it never touches our
//     applications table or the recruiter dashboard.
//   - recruiter_email: the client/recruiter this job was posted for. Used
//     ONLY for one-click ('platform') jobs, where applications live in our
//     system and the recruiter needs the code-verified link to see them.
//     The recruiter-view code flow below sends to recruiter_email, not
//     apply_email — don't swap these back.
//
// Uses the shared service-role Supabase client (bypasses RLS for admin
// queries and writing applications on the user's behalf).

import { supabase } from "../config/supabase.js"; // service-role client
import crypto from "crypto";
import jwt from "jsonwebtoken"; // npm install jsonwebtoken
import { sendEmail } from "../lib/email.js";
import {
  recruiterLinkEmail,
  recruiterAccessCodeEmail,
  applicationConfirmationEmail,
} from "../lib/emailTemplates.js";

// =============================
// POST /applications
// One-click ("platform") or logging an ("email") apply.
// =============================
export const createApplication = async (req, res) => {
  const applicantId = req.user.id;
  const { job_id, method, email_sent_to, email_body } = req.body;

  if (!job_id || !method) {
    return res.status(400).json({ message: "job_id and method are required" });
  }
  if (!["platform", "email"].includes(method)) {
    return res.status(400).json({ message: "method must be 'platform' or 'email'" });
  }

  // Upsert so re-clicking Apply (or re-sending the email) updates the
  // existing row instead of hitting the unique (job_id, applicant_id) constraint.
  const { data, error } = await supabase
    .from("applications")
    .upsert(
      {
        job_id,
        applicant_id: applicantId,
        method,
        status: "applied",
        email_sent_to: method === "email" ? email_sent_to : null,
        email_body: method === "email" ? email_body : null,
        applied_at: new Date().toISOString(),
      },
      { onConflict: "job_id,applicant_id" }
    )
    .select()
    .single();

  if (error) return res.status(500).json({ message: error.message });

  // ✅ Fire-and-forget confirmation email to the applicant — applying
  // should succeed for the user even if Resend is slow/down, so this is
  // never awaited and never allowed to throw back into the response.
  (async () => {
    try {
      const { data: job } = await supabase
        .from("jobs")
        .select("title, slug, companies(name)")
        .eq("id", job_id)
        .single();

      const { subject, html } = applicationConfirmationEmail({
        jobTitle: job?.title || "the job",
        companyName: job?.companies?.name || "",
        applicantName: req.user.user_metadata?.full_name || req.user.email?.split("@")[0],
        jobUrl: job?.slug ? `${process.env.PUBLIC_SITE_URL || "https://jobnix.ng"}/jobs/${job.slug}` : null,
      });

      await sendEmail({ to: req.user.email, subject, html });
    } catch (emailErr) {
      console.error("Application confirmation email failed:", emailErr.message);
    }
  })();

  return res.status(201).json({ data });
};

// =============================
// GET /applications/job/:jobId
// The signed-in user's own application for one job — powers the
// "Applied" vs "Apply Now" state in JobApplyButton.
// =============================
export const getApplicationForJob = async (req, res) => {
  const applicantId = req.user.id;
  const { jobId } = req.params;

  const { data, error } = await supabase
    .from("applications")
    .select("*")
    .eq("job_id", jobId)
    .eq("applicant_id", applicantId)
    .maybeSingle();

  if (error) return res.status(500).json({ message: error.message });
  if (!data) return res.status(404).json({ message: "Not applied yet" });
  return res.json({ data });
};

// =============================
// GET /applications/me
// All of the signed-in user's applications, with job details joined in —
// powers the "My Applications" page.
// ✅ UPDATED: now also pulls work_type (for the Corporate/Informal split)
// and the job's company name + logo_url, so the frontend can render the
// company logo instead of falling back to an initial letter.
// =============================
export const getMyApplications = async (req, res) => {
  const applicantId = req.user.id;

  const { data, error } = await supabase
    .from("applications")
    .select(`
      id, method, status, applied_at,
      jobs (
        id, title, company_id, role_category, location, work_type,
        companies ( name, logo_url )
      )
    `)
    .eq("applicant_id", applicantId)
    .order("applied_at", { ascending: false });

  if (error) return res.status(500).json({ message: error.message });
  return res.json({ data });
};

// =============================
// ADMIN — GET /admin/applications
// Every application across every job. This is the dashboard list.
// Protected by adminCheck — no role check needed here.
// =============================
export const getAllApplicationsAdmin = async (req, res) => {
  const { data, error } = await supabase
    .from("applications")
    .select(`
      id, method, status, applied_at, email_sent_to,
      jobs ( id, title, company_id, recruiter_email, companies ( name ) ),
      profiles:applicant_id (
        id, email,
        user_profiles ( full_name, avatar_url, cv_url )
      )
    `)
    .order("applied_at", { ascending: false });

  if (error) return res.status(500).json({ message: error.message });
  return res.json({ data });
};

// =============================
// ADMIN — GET /admin/jobs/:jobId/applications
// Just the applicants for one job — same data the recruiter link shows,
// but from the admin's authenticated dashboard instead of a public token.
// Protected by adminCheck — no role check needed here.
// =============================
export const getApplicationsForJobAdmin = async (req, res) => {
  const { jobId } = req.params;

  const { data, error } = await supabase
    .from("applications")
    .select(`
      id, method, status, applied_at,
      profiles:applicant_id (
        id, email,
        user_profiles ( full_name, avatar_url, cv_url )
      )
    `)
    .eq("job_id", jobId)
    .order("applied_at", { ascending: false });

  if (error) return res.status(500).json({ message: error.message });
  return res.json({ data });
};

// =============================
// ADMIN — POST /admin/jobs/:jobId/recruiter-link
// Generates (or returns the existing) shareable token for a job, and hands
// back the full URL to copy/send to the employer.
// Protected by adminCheck — no role check needed here.
// =============================
// ✅ The admin dashboard can be hit from localhost during development or
// from the real jobnix.ng domain in production — the recruiter link should
// match whichever one the admin is actually using, not always the same
// hardcoded env var. Only known origins are allowed here (not just anything
// sent in the Origin header) so this can't be abused to point recruiters at
// an attacker-controlled domain.
const ALLOWED_LINK_ORIGINS = [
  "http://localhost:5173",
  "https://jobnix.ng",
  "https://www.jobnix.ng",
];

const resolveLinkOrigin = (req) => {
  const origin = req.headers.origin;
  if (origin && ALLOWED_LINK_ORIGINS.includes(origin)) return origin;
  return process.env.PUBLIC_SITE_URL || null;
};

export const getOrCreateRecruiterLink = async (req, res) => {
  const { jobId } = req.params;

  const linkOrigin = resolveLinkOrigin(req);
  if (!linkOrigin) {
    return res.status(500).json({ message: "Server misconfigured: no known site origin for building this link." });
  }

  const { data: job, error: fetchErr } = await supabase
    .from("jobs")
    .select("id, title, recruiter_view_token, recruiter_email, apply_method")
    .eq("id", jobId)
    .single();

  if (fetchErr) return res.status(404).json({ message: "Job not found" });

  // A recruiter link only makes sense for one-click jobs — that's the only
  // apply_method where applications live in our system for a recruiter to
  // view. Check apply_method explicitly rather than relying on recruiter_email
  // happening to be blank for other methods.
  if (job.apply_method !== "platform") {
    return res.status(400).json({ message: "Recruiter links are only available for one-click apply jobs." });
  }
  if (!job.recruiter_email) {
    return res.status(400).json({ message: "This job has no recruiter email on file — add one before generating a link." });
  }

  let token = job.recruiter_view_token;
  if (!token) {
    token = crypto.randomBytes(16).toString("hex"); // 32-char unguessable token
    const { error: updateErr } = await supabase
      .from("jobs")
      .update({ recruiter_view_token: token })
      .eq("id", jobId);
    if (updateErr) return res.status(500).json({ message: updateErr.message });
  }

  const url = `${linkOrigin}/recruiter-view/${token}`;

  // ✅ Auto-email the link to the recruiter every time the admin clicks
  // "Get recruiter link" — whether it's brand new or already existed, this
  // doubles as a "resend" so the admin doesn't have to copy/paste manually.
  try {
    const { subject, html } = recruiterLinkEmail({ jobTitle: job.title, url });
    await sendEmail({ to: job.recruiter_email, subject, html });
  } catch (emailErr) {
    // Token is already saved at this point — don't lose that — but tell the
    // admin the email itself failed so they can send the link manually.
    return res.status(502).json({
      message: `Link created, but the email to the recruiter failed to send: ${emailErr.message}`,
      data: { token, url },
    });
  }

  return res.json({ data: { token, url } });
};

// =============================
// PUBLIC — GET /recruiter-view/:token
// No auth, but only returns enough to confirm the link is valid — NOT the
// applicant list. That's unlocked separately via request-code/verify-code.
// =============================
export const getRecruiterView = async (req, res) => {
  const { token } = req.params;

  const { data: job, error } = await supabase
    .from("jobs")
    .select("id, title, location, job_type, apply_method, recruiter_email")
    .eq("recruiter_view_token", token)
    .maybeSingle();

  if (error) return res.status(500).json({ message: error.message });
  if (!job) return res.status(404).json({ message: "This link is invalid or has expired." });
  if (job.apply_method !== "platform") {
    return res.status(400).json({ message: "This link is no longer valid for this job." });
  }

  // Mask the email so the page can say "code sent to j***@company.com"
  // without fully exposing the address to anyone who just has the link.
  const masked = job.recruiter_email
    ? job.recruiter_email.replace(/^(.).*(@.*)$/, (_, first, domain) => `${first}***${domain}`)
    : null;

  return res.json({ data: { id: job.id, title: job.title, location: job.location, job_type: job.job_type, masked_email: masked } });
};

// =============================
// PUBLIC — POST /recruiter-view/:token/request-code
// Emails a 6-digit code to the job's recruiter_email. Rate-limit this route
// at the infra/middleware level — it's an easy target for spamming an inbox.
// =============================
export const requestRecruiterCode = async (req, res) => {
  const { token } = req.params;

  const { data: job, error } = await supabase
    .from("jobs")
    .select("id, title, apply_method, recruiter_email")
    .eq("recruiter_view_token", token)
    .maybeSingle();

  if (error) return res.status(500).json({ message: error.message });
  if (!job) return res.status(404).json({ message: "This link is invalid or has expired." });
  if (job.apply_method !== "platform") {
    return res.status(400).json({ message: "This link is no longer valid for this job." });
  }
  if (!job.recruiter_email) return res.status(400).json({ message: "No contact email on file for this job." });

  const code = String(crypto.randomInt(100000, 999999));
  const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString(); // 10 min

  const { error: insertErr } = await supabase
    .from("recruiter_access_codes")
    .insert({ job_id: job.id, code, expires_at: expiresAt });

  if (insertErr) return res.status(500).json({ message: insertErr.message });

  const { subject, html } = recruiterAccessCodeEmail({ jobTitle: job.title, code });
  await sendEmail({ to: job.recruiter_email, subject, html });

  return res.json({ message: "Code sent." });
};

// =============================
// PUBLIC — POST /recruiter-view/:token/verify-code
// Checks the code, marks it used (single-use), and — if valid — returns
// the applicant list plus a short-lived access token so the page can
// refresh the list later without asking for a new code every time.
// =============================
export const verifyRecruiterCode = async (req, res) => {
  const { token } = req.params;
  const { code } = req.body;
  if (!code) return res.status(400).json({ message: "Code is required" });

  const { data: job, error: jobErr } = await supabase
    .from("jobs")
    .select("id, title, location, job_type, apply_method")
    .eq("recruiter_view_token", token)
    .maybeSingle();

  if (jobErr) return res.status(500).json({ message: jobErr.message });
  if (!job) return res.status(404).json({ message: "This link is invalid or has expired." });
  if (job.apply_method !== "platform") {
    return res.status(400).json({ message: "This link is no longer valid for this job." });
  }

  const { data: codeRow, error: codeErr } = await supabase
    .from("recruiter_access_codes")
    .select("*")
    .eq("job_id", job.id)
    .eq("code", code)
    .is("used_at", null)
    .gt("expires_at", new Date().toISOString())
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (codeErr) return res.status(500).json({ message: codeErr.message });
  if (!codeRow) return res.status(400).json({ message: "Invalid or expired code." });

  await supabase.from("recruiter_access_codes").update({ used_at: new Date().toISOString() }).eq("id", codeRow.id);

  const { data: applications, error: appsErr } = await supabase
    .from("applications")
    .select(`
      id, applied_at,
      profiles:applicant_id (
        user_profiles ( full_name, avatar_url, cv_url )
      )
    `)
    .eq("job_id", job.id)
    .order("applied_at", { ascending: false });

  if (appsErr) return res.status(500).json({ message: appsErr.message });

  // Short-lived (1hr) token scoped to this one job — lets the page reload
  // the list later via getRecruiterApplications without emailing a new code.
  const accessToken = jwt.sign({ job_id: job.id, token }, process.env.RECRUITER_JWT_SECRET, { expiresIn: "1h" });

  return res.json({ data: { job, applications, access_token: accessToken } });
};

// =============================
// PUBLIC — GET /recruiter-view/:token/applications
// Refresh the applicant list using the access_token from verify-code,
// instead of re-emailing a code every page load.
// =============================
export const getRecruiterApplications = async (req, res) => {
  const { token } = req.params;
  const authHeader = req.headers.authorization || "";
  const bearer = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null;
  if (!bearer) return res.status(401).json({ message: "Access token required" });

  let payload;
  try {
    payload = jwt.verify(bearer, process.env.RECRUITER_JWT_SECRET);
  } catch {
    return res.status(401).json({ message: "Access token expired — request a new code." });
  }
  if (payload.token !== token) return res.status(401).json({ message: "Token mismatch." });

  const { data: applications, error } = await supabase
    .from("applications")
    .select(`
      id, applied_at,
      profiles:applicant_id (
        user_profiles ( full_name, avatar_url, cv_url )
      )
    `)
    .eq("job_id", payload.job_id)
    .order("applied_at", { ascending: false });

  if (error) return res.status(500).json({ message: error.message });
  return res.json({ data: applications });
};