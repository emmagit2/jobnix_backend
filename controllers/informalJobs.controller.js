// ═══════════════════════════════════════════════════════════════════════════
// controllers/informalJobs.controller.js  (NEW FILE)
//
// Everything about informal jobs that changed: areas, informal pay, duration
// plans (3 weeks / 1 month / 2 months), workers needed (+₦500 for 2 or 3),
// one edit in the first 3 days, review days given back, and decline reasons.
//
// jobs.controller.js re-exports these five functions, so your routes do not
// need to change:  submitInformalJob, updateInformalJob, approveJob,
// rejectJob, getMyJobs
//
// Run jobnix-informal-migration.sql in Supabase BEFORE deploying this.
// ═══════════════════════════════════════════════════════════════════════════

import { supabase } from "../config/supabase.js";
import * as notificationService from "../services/notificationService.js";

// Same slug generator as jobs.controller.js (kept here so this file doesn't
// import from that one, which would be a circular import).
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

// ───────────────────────────────────────────────────────────────────────────
// SECTION 1 — settings and helpers (paste under your imports)
// ───────────────────────────────────────────────────────────────────────────

// How long a job runs and what it costs (NGN). The server decides the price,
// the form only sends the plan id.
const INFORMAL_PLANS = {
  "3w": { days: 21, fee: 1500 },
  "1m": { days: 30, fee: 2500 },
  "2m": { days: 60, fee: 3500 },
};

// Extra charge by number of workers needed. 1 worker = no extra.
// 2 or 3 workers = ₦500 on top. Change the numbers here any time.
const MAX_WORKERS = 3;
const WORKER_TOPUP = { 1: 0, 2: 500, 3: 500 };

// A live job gets ONE edit, and only in the first 3 days after it went live.
// After that (or once the edit is used) the business must extend the job or post a new one.
const EDIT_LIMIT = 1;
const EDIT_WINDOW_DAYS = 3;
const DAY_MS = 86400000;

const INFORMAL_STATES = [
  "Abia", "Adamawa", "Akwa Ibom", "Anambra", "Bauchi", "Bayelsa", "Benue", "Borno", "Cross River", "Delta",
  "Ebonyi", "Edo", "Ekiti", "Enugu", "FCT (Abuja)", "Gombe", "Imo", "Jigawa", "Kaduna", "Kano", "Katsina",
  "Kebbi", "Kogi", "Kwara", "Lagos", "Nasarawa", "Niger", "Ogun", "Ondo", "Osun", "Oyo", "Plateau",
  "Rivers", "Sokoto", "Taraba", "Yobe", "Zamfara",
];
const PAY_TYPES = ["Daily", "Weekly", "Monthly", "Per job"];

const cleanLocations = (list) => {
  if (!Array.isArray(list)) return [];
  const seen = new Set();
  return list
    .map((s) => String(s).trim().replace(/\s+/g, " ").slice(0, 60))
    .filter((s) => s && !seen.has(s.toLowerCase()) && seen.add(s.toLowerCase()))
    .slice(0, 30);
};

// Keep what the user typed ("₦15,000", "15k - 20k"), just tidied and length-limited.
const cleanPay = (text) => {
  const s = String(text ?? "").trim().replace(/\s+/g, " ").slice(0, 40);
  return s || null;
};

// Returns { error } or { state, locations, payType, payAmount }
const readInformalExtras = (body) => {
  const { candidate_state, candidate_locations, pay_type, pay_amount } = body;
  if (!INFORMAL_STATES.includes(candidate_state)) return { error: "Choose a valid state to hire from." };

  const locations = cleanLocations(candidate_locations);
  if (locations.length === 0) return { error: "Choose where to hire from." };

  const allEntry = `All ${candidate_state}`;
  const hasAll = locations.some((l) => l.toLowerCase() === allEntry.toLowerCase());
  if (hasAll && locations.length > 1) return { error: "Choose either the whole state or specific areas, not both." };

  return {
    state: candidate_state,
    locations: hasAll ? [allEntry] : locations,
    payType: PAY_TYPES.includes(pay_type) ? pay_type : null,
    payAmount: cleanPay(pay_amount),
  };
};

// Returns { workers } or { error }
const readWorkers = (value) => {
  const n = Number(value ?? 1);
  if (!Number.isInteger(n) || n < 1 || n > MAX_WORKERS) {
    return { error: `Choose how many workers you need (1 to ${MAX_WORKERS}).` };
  }
  return { workers: n };
};

// What the business pays: plan price + worker top-up.
const priceFor = (planId, workers) =>
  (INFORMAL_PLANS[planId]?.fee ?? 0) + (WORKER_TOPUP[workers] ?? 0);

const formatDate = (d) =>
  new Date(d).toLocaleDateString("en-NG", { day: "numeric", month: "long", year: "numeric" });

// ── Editing rules ──────────────────────────────────────────────────────────
// A job that has never been live (unpaid, waiting for first review, or rejected
// before going live) can be changed freely. Once a job has been live:
//   - it gets ONE edit (edit_count), and only within 3 days of first going live
//   - after that, or once the edit is used, it is locked: the business must
//     extend the same job, or post a new one
//   - fixing a rejection never counts as the edit
// Returns null when there is nothing to enforce, { locked: false, ... } when an
// edit is still allowed, or { locked: true, code, message } when it is not.
const getEditInfo = (job) => {
  if (job.work_type !== "informal" || !job.starts_at) return null; // never been live

  const now = Date.now();
  const ended = job.expires_at && new Date(job.expires_at).getTime() <= now;

  if (ended) {
    return {
      locked: true,
      code: "JOB_ENDED",
      message:
        "This job has ended, so it can't be edited. To hire again, post it again: your details are copied, " +
        "and you can change the location or the number of workers.",
    };
  }

  // A rejection must always be fixable, so it is never locked or counted.
  if (job.status === "rejected") return null;

  const used = job.edit_count || 0;

  // The one edit was used and the job is waiting for the admin to review it.
  if (job.status === "pending") {
    return {
      locked: true,
      code: "IN_REVIEW",
      message: "Your edited job is waiting for review, so it can't be changed again until the review is done.",
    };
  }

  if (job.status !== "approved") return null;

  const editableUntil = new Date(new Date(job.starts_at).getTime() + EDIT_WINDOW_DAYS * DAY_MS);

  if (Date.now() > editableUntil.getTime()) {
    return {
      locked: true,
      code: "EDIT_LOCKED",
      message:
        `A job can only be edited in the first ${EDIT_WINDOW_DAYS} days after it goes live. ` +
        `This job went live on ${formatDate(job.starts_at)}, so editing closed on ${formatDate(editableUntil)}. ` +
        `To keep this same job running, extend it. To change the location or hire more workers, ` +
        `post it again as a new job (your details are copied).`,
    };
  }

  if (used >= EDIT_LIMIT) {
    return {
      locked: true,
      code: "EDIT_USED",
      message:
        "You have already used the one edit allowed for this job. " +
        "To keep this same job running, extend it. To change the location or hire more workers, " +
        "post it again as a new job (your details are copied).",
    };
  }

  return { locked: false, editable_until: editableUntil.toISOString(), edits_left: EDIT_LIMIT - used };
};

// ── Review time is given back ──────────────────────────────────────────────
// When a live job is edited it goes back to review and is offline. The time it
// waits for the admin is added back to its end date so the business loses no days.
// Returns the new end date, or null if the job has no running clock yet.
const creditedExpiry = (job, now = new Date()) => {
  if (!job.expires_at || !job.review_started_at) return null;
  const waited = Math.max(0, now.getTime() - new Date(job.review_started_at).getTime());
  return new Date(new Date(job.expires_at).getTime() + waited).toISOString();
};

// Time fields to set when an informal job is approved.
const approvalTimeFields = (job, now = new Date()) => {
  if (job.work_type !== "informal") return {};

  // Re-approval after an edit: give back the days it waited.
  const credited = creditedExpiry(job, now);
  if (credited) return { expires_at: credited, review_started_at: null };

  // First approval: the clock starts now.
  if (job.duration_days) {
    return {
      starts_at: now.toISOString(),
      expires_at: new Date(now.getTime() + job.duration_days * DAY_MS).toISOString(),
      review_started_at: null,
    };
  }
  return {};
};


// ───────────────────────────────────────────────────────────────────────────
// SECTION 2 — functions to REPLACE in the controller
// ───────────────────────────────────────────────────────────────────────────

// ─── CREATE INFORMAL JOB (business or agent submits — goes to "pending") ─────
export const submitInformalJob = async (req, res) => {
  try {
    const {
      title, location, role_category, description, responsibilities, benefits,
      postAs, // 'owner' | 'agent'
      agent_name, agent_phone, // only meaningful when postAs === 'agent'
    } = req.body;

    if (!req.businessId) {
      return res.status(401).json({ success: false, message: "Must be logged in as a business to submit a job" });
    }

    const cleanTitle = String(title ?? "").trim().replace(/\s+/g, " ").slice(0, 120);
    const cleanDescription = String(description ?? "").trim();
    if (!cleanTitle || !cleanDescription) {
      return res.status(400).json({ success: false, message: "Title and description are required" });
    }

    // Candidate state/areas and pay (informal jobs use pay_type + pay_amount, not salary_min/max)
    const extras = readInformalExtras(req.body);
    if (extras.error) return res.status(400).json({ success: false, message: extras.error });

    // How long the job runs, and how many workers are needed
    const planId = req.body.plan;
    const plan = INFORMAL_PLANS[planId];
    if (!plan) return res.status(400).json({ success: false, message: "Choose how long your job should run." });

    const w = readWorkers(req.body.workers_needed);
    if (w.error) return res.status(400).json({ success: false, message: w.error });

    const isAgent = postAs === "agent";
    const cleanAgentName = String(agent_name ?? "").trim();
    const cleanAgentPhone = String(agent_phone ?? "").trim();
    if (isAgent && (!cleanAgentName || !cleanAgentPhone)) {
      return res.status(400).json({ success: false, message: "Agent name and phone are required when posting as an agent" });
    }

    const shortId = Math.random().toString(36).slice(2, 8);
    const slug = generateSlug(cleanTitle, "", location, shortId);

    const { data, error } = await supabase
      .from("jobs")
      .insert([{
        title: cleanTitle,
        location,
        role_category,
        work_type: "informal",
        job_type: "Full-time",
        description: cleanDescription,
        requirements: [],
        responsibilities: responsibilities || [],
        benefits: benefits || [],

        // Informal pay (formal jobs use salary_min / salary_max instead)
        pay_type: extras.payType,
        pay_amount: extras.payAmount,

        // Where candidates should come from
        candidate_state: extras.state,
        candidate_locations: extras.locations,

        // How long it runs and how many workers. The clock starts when the admin approves.
        plan: planId,
        duration_days: plan.days,
        workers_needed: w.workers,

        // Informal jobs are always one-click. Set here so the client can't send anything else.
        apply_method: "platform",
        apply_link: null,
        apply_email: null,
        how_to_apply: null,
        recruiter_email: null,
        slug,

        // Approval — pending until admin reviews
        status: "pending",
        submitted_by_business_id: req.businessId,

        // Agent
        posted_by_type: isAgent ? "agent" : "owner",
        agent_name: isAgent ? cleanAgentName : null,
        agent_phone: isAgent ? cleanAgentPhone : null,
        agent_liability_accepted: isAgent,
        agent_liability_accepted_at: isAgent ? new Date().toISOString() : null,

        // Payment — required before the job can go live. Plan price + worker top-up.
        payment_status: "pending",
        payment_amount: priceFor(planId, w.workers),
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

// ─── BUSINESS: EDIT MY INFORMAL JOB ───────────────────────────────────────────
export const updateInformalJob = async (req, res) => {
  try {
    const { id } = req.params;
    const {
      title, location, role_category, description, responsibilities, benefits,
      postAs, agent_name, agent_phone,
    } = req.body;

    if (!req.businessId) {
      return res.status(401).json({ success: false, message: "Must be logged in as a business" });
    }

    const { data: existing, error: fetchErr } = await supabase
      .from("jobs")
      .select(
        "id, work_type, submitted_by_business_id, status, slug, plan, workers_needed, payment_status, " +
        "starts_at, expires_at, edit_count, agent_liability_accepted, agent_liability_accepted_at"
      )
      .eq("id", id)
      .maybeSingle();
    if (fetchErr) throw fetchErr;

    // 404 rather than 403 so we don't reveal that the job exists
    if (!existing || existing.work_type !== "informal" || existing.submitted_by_business_id !== req.businessId) {
      return res.status(404).json({ success: false, message: "Job not found" });
    }

    // A live job gets one edit, in its first 3 days. (Never-live jobs and rejected jobs are free to fix.)
    const editInfo = getEditInfo(existing);
    if (editInfo?.locked) {
      return res.status(403).json({ success: false, code: editInfo.code, message: editInfo.message });
    }

    // A rejected job whose time already ran out can't come back.
    if (existing.status === "rejected" && existing.expires_at && new Date(existing.expires_at) < new Date()) {
      return res.status(403).json({
        success: false,
        code: "JOB_ENDED",
        message: "This job's time has ended, so it can't be resubmitted. Post it again as a new job: your details are copied.",
      });
    }

    const cleanTitle = String(title ?? "").trim().replace(/\s+/g, " ").slice(0, 120);
    const cleanDescription = String(description ?? "").trim();
    if (!cleanTitle || !cleanDescription) {
      return res.status(400).json({ success: false, message: "Title and description are required" });
    }

    const extras = readInformalExtras(req.body);
    if (extras.error) return res.status(400).json({ success: false, message: extras.error });

    const isAgent = postAs === "agent";
    const cleanAgentName = String(agent_name ?? "").trim();
    const cleanAgentPhone = String(agent_phone ?? "").trim();
    if (isAgent && (!cleanAgentName || !cleanAgentPhone)) {
      return res.status(400).json({ success: false, message: "Agent name and phone are required when posting as an agent" });
    }

    // Plan and number of workers can change only while the job is still unpaid
    // (the cancel-the-payment-popup-and-edit case). Once paid, the price is fixed.
    let planFields = {};
    if (existing.payment_status === "pending") {
      const planId = INFORMAL_PLANS[req.body.plan] ? req.body.plan : existing.plan;
      if (!INFORMAL_PLANS[planId]) {
        return res.status(400).json({ success: false, message: "Choose how long your job should run." });
      }
      const w = readWorkers(req.body.workers_needed ?? existing.workers_needed);
      if (w.error) return res.status(400).json({ success: false, message: w.error });

      planFields = {
        plan: planId,
        duration_days: INFORMAL_PLANS[planId].days,
        workers_needed: w.workers,
        payment_amount: priceFor(planId, w.workers),
      };
    }

    // Keep the same slug suffix, regenerate the readable part in case title/location changed.
    const existingShortId = existing.slug?.split("-").pop() || Math.random().toString(36).slice(2, 8);
    const slug = generateSlug(cleanTitle, "", location, existingShortId);

    const wasApproved = existing.status === "approved";
    const wasRejected = existing.status === "rejected";
    const nowIso = new Date().toISOString();

    const { data, error } = await supabase
      .from("jobs")
      .update({
        title: cleanTitle,
        location,
        role_category,
        description: cleanDescription,
        responsibilities: responsibilities || [],
        benefits: benefits || [],

        pay_type: extras.payType,
        pay_amount: extras.payAmount,
        candidate_state: extras.state,
        candidate_locations: extras.locations,
        ...planFields,
        slug,

        posted_by_type: isAgent ? "agent" : "owner",
        agent_name: isAgent ? cleanAgentName : null,
        agent_phone: isAgent ? cleanAgentPhone : null,
        agent_liability_accepted: isAgent ? true : existing.agent_liability_accepted,
        agent_liability_accepted_at: isAgent
          ? (existing.agent_liability_accepted_at || nowIso)
          : existing.agent_liability_accepted_at,

        // A live job goes back to review, and a rejected one goes back too.
        // review_started_at notes when the wait began so the time can be given back on approval.
        ...(wasApproved
          ? {
              status: "pending", approved_by: null, approved_at: null, review_started_at: nowIso,
              edit_count: (existing.edit_count || 0) + 1, // this was the business's one edit
            }
          : {}),
        ...(wasRejected
          ? { status: "pending", rejection_reason: null, review_started_at: nowIso }
          : {}),
      })
      .eq("id", id)
      .select()
      .single();
    if (error) throw error;

    res.json({
      success: true,
      data,
      message: wasApproved
        ? "Job updated and sent for review. That was your one edit for this job, so it can't be edited again. While it waits for approval the days are paused: they are added back to your running time, so you won't lose any."
        : wasRejected
        ? "Job updated and sent back for review."
        : "Job updated.",
    });
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
      .select("title, payment_status, work_type, duration_days, expires_at, review_started_at, submitted_by_business_id")
      .eq("id", id)
      .single();
    if (fetchErr) throw fetchErr;

    if (job.payment_status !== "paid") {
      return res.status(400).json({ success: false, message: "Cannot approve a job that hasn't been paid for" });
    }

    const now = new Date();

    const { data, error } = await supabase
      .from("jobs")
      .update({
        status: "approved",
        approved_by: req.userId,
        approved_at: now.toISOString(),
        // First approval starts the clock; re-approval after an edit gives back the review days.
        ...approvalTimeFields(job, now),
      })
      .eq("id", id)
      .select()
      .single();
    if (error) throw error;

    // Mark any pending referral commission tied to this job as paid, now that the
    // job it was earned from has actually been approved, then tell the referrer.
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

// ─── ADMIN: REJECT (a reason is required so the business knows what to fix) ──
export const rejectJob = async (req, res) => {
  try {
    const { id } = req.params;

    const reason = String(req.body.reason ?? "").trim().replace(/\s+/g, " ").slice(0, 500);
    if (reason.length < 10) {
      return res.status(400).json({
        success: false,
        message: "Give a reason (at least 10 characters) so the business knows what to fix.",
      });
    }

    const { data: job, error: fetchErr } = await supabase
      .from("jobs")
      .select("title, status, expires_at, review_started_at, submitted_by_business_id")
      .eq("id", id)
      .single();
    if (fetchErr) throw fetchErr;

    if (job.status !== "pending") {
      return res.status(400).json({ success: false, message: "Only jobs waiting for review can be rejected" });
    }

    // If this was a live job that was edited, the days it waited for the admin are still given back.
    const credited = creditedExpiry(job);

    const { data, error } = await supabase
      .from("jobs")
      .update({
        status: "rejected",
        rejection_reason: reason,
        review_started_at: null,
        ...(credited ? { expires_at: credited } : {}),
      })
      .eq("id", id)
      .select()
      .single();
    if (error) throw error;

    if (job.submitted_by_business_id && typeof notificationService.notifyJobRejected === "function") {
      try {
        await notificationService.notifyJobRejected(job.submitted_by_business_id, job.title, reason);
      } catch (notifyErr) {
        console.error("notifyJobRejected failed (non-fatal):", notifyErr.message);
      }
    }

    res.json({ success: true, data, message: "Job rejected" });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// ─── BUSINESS: MY JOBS (each job says whether it can still be edited) ────────
export const getMyJobs = async (req, res) => {
  try {
    const { data: me, error: meErr } = await supabase.from("profiles").select("email").eq("id", req.businessId).single();
    if (meErr) throw meErr;

    // Two simple queries instead of one .or() string, so an email with special
    // characters can't break the filter. "%" "_" "\" are escaped for ilike.
    const safeEmail = String(me.email || "").replace(/[\\%_]/g, "\\$&");
    const select = "*, companies(id, name, logo_url)";

    const [byEmail, byBusiness] = await Promise.all([
      safeEmail
        ? supabase.from("jobs").select(select).ilike("recruiter_email", safeEmail)
        : Promise.resolve({ data: [], error: null }),
      supabase.from("jobs").select(select).eq("submitted_by_business_id", req.businessId),
    ]);
    if (byEmail.error) throw byEmail.error;
    if (byBusiness.error) throw byBusiness.error;

    const seen = new Set();
    const jobs = [...(byEmail.data || []), ...(byBusiness.data || [])]
      .filter((j) => !seen.has(j.id) && seen.add(j.id))
      .sort((a, b) => new Date(b.created_date) - new Date(a.created_date));

    const data = jobs.map((j) => {
      const info = getEditInfo(j);
      return {
        ...j,
        // null = nothing special; { code, message } = locked; editable_until = last day to edit
        edit_lock: info?.locked ? { code: info.code, message: info.message } : null,
        editable_until: info && !info.locked ? info.editable_until : null,
        edits_left: info && !info.locked ? info.edits_left : 0,
      };
    });

    res.json({ success: true, data });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};