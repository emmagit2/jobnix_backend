// services/jobAlertService.js
//
// Finds who is due a job email, matches approved jobs to each person, and
// sends it. Matching rules live in lib/jobMatching.js.
//
//   runJobAlerts("instant" | "daily" | "weekly" | "monthly")
//   runUrgentAlerts()
//   getMatchesForUser(userId)        <- for the dashboard "matched jobs" list

import { supabase } from "../config/supabase.js";
import { matchJobsForUser } from "../lib/jobMatching.js";
import { buildJobAlertEmail } from "../lib/jobAlertEmail.js";
import { sendEmail } from "../lib/email.js";

// How far back each email looks for jobs. Overlap is safe because
// job_alert_log stops a job being sent to the same person twice.
const LOOKBACK_DAYS = { instant: 1, daily: 1, weekly: 7, monthly: 31 };
const MAX_JOBS_PER_EMAIL = 10;
const MAX_CANDIDATE_JOBS = 300;
const USER_PAGE = 100;

const JOB_SELECT =
  "id, title, slug, location, job_type, role_category, work_type, description, " +
  "salary_min, salary_max, salary_currency, pay_type, pay_amount, deadline, " +
  "created_at, approved_at, starts_at, expires_at, is_urgent, " +
  "candidate_state, candidate_locations";

const USER_SELECT =
  "id, email, first_name, full_name, location, roles, job_locations, " +
  "alert_categories, alert_frequency, alert_day, urgent_alerts, alerts_enabled";

const daysAgo = (d) => new Date(Date.now() - d * 86400000).toISOString();

// Today's weekday and date in Nigeria, whatever timezone the server is in
function lagosToday() {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Africa/Lagos", weekday: "long", year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(new Date());
  const get = (t) => parts.find((p) => p.type === t).value;
  return { weekday: get("weekday"), date: `${get("year")}-${get("month")}-${get("day")}` };
}

// ── Jobs ─────────────────────────────────────────────────────────────────────
// Approved, paid-or-free, not expired, and new since `sinceISO`.
// A job counts as "new" from the moment it was approved, not just created.
async function fetchCandidateJobs(sinceISO, { urgentOnly = false } = {}) {
  const nowISO = new Date().toISOString();
  let q = supabase
    .from("jobs")
    .select(JOB_SELECT)
    .eq("status", "approved")
    .in("payment_status", ["not_required", "paid"])
    .or(`approved_at.gte.${sinceISO},and(approved_at.is.null,created_at.gte.${sinceISO})`)
    .or(`deadline.is.null,deadline.gte.${lagosToday().date}`)
    .or(`expires_at.is.null,expires_at.gt.${nowISO}`)
    .order("created_at", { ascending: false })
    .limit(MAX_CANDIDATE_JOBS);

  if (urgentOnly) {
    const in24h = new Date(Date.now() + 86400000).toISOString();
    q = q.or(
      `is_urgent.eq.true,and(work_type.eq.informal,starts_at.gte.${nowISO},starts_at.lte.${in24h})`
    );
  }

  const { data, error } = await q;
  if (error) throw error;
  return data || [];
}

// ── Users ────────────────────────────────────────────────────────────────────
async function* userPages(applyFilters) {
  for (let from = 0; ; from += USER_PAGE) {
    let q = supabase
      .from("user_profiles")
      .select(USER_SELECT)
      .eq("alerts_enabled", true)
      .not("email", "is", null)
      .order("id")
      .range(from, from + USER_PAGE - 1);
    q = applyFilters(q);
    const { data, error } = await q;
    if (error) throw error;
    if (!data?.length) return;
    yield data;
    if (data.length < USER_PAGE) return;
  }
}

// ── Sending ──────────────────────────────────────────────────────────────────
// Claim jobs for a user BEFORE emailing. The (user_id, job_id) primary key
// means a job already sent, or being sent by an overlapping run, comes back
// as "not claimed", so nobody gets duplicates.
async function claimJobs(userId, ranked, kind) {
  const claimed = [];
  for (let i = 0; i < ranked.length && claimed.length < MAX_JOBS_PER_EMAIL && i < 50; i += MAX_JOBS_PER_EMAIL) {
    const chunk = ranked.slice(i, i + MAX_JOBS_PER_EMAIL);
    const { data, error } = await supabase
      .from("job_alert_log")
      .upsert(
        chunk.map((m) => ({ user_id: userId, job_id: m.job.id, kind })),
        { onConflict: "user_id,job_id", ignoreDuplicates: true }
      )
      .select("job_id");
    if (error) throw error;
    const won = new Set((data || []).map((r) => r.job_id));
    claimed.push(...chunk.filter((m) => won.has(m.job.id)));
  }
  return claimed.slice(0, MAX_JOBS_PER_EMAIL);
}

async function releaseClaim(userId, matches) {
  await supabase
    .from("job_alert_log")
    .delete()
    .eq("user_id", userId)
    .in("job_id", matches.map((m) => m.job.id));
}

async function alertOneUser(user, jobs, { kind, urgent }) {
  const ranked = matchJobsForUser(jobs, user, { ignoreCategories: urgent });
  if (ranked.length === 0) return { status: "no_match", jobs: 0 };

  const claimed = await claimJobs(user.id, ranked, kind);
  if (claimed.length === 0) return { status: "already_sent", jobs: 0 };

  try {
    const email = buildJobAlertEmail(user, claimed, { urgent, totalMatches: ranked.length });
    await sendEmail({ to: user.email, ...email });
    return { status: "sent", jobs: claimed.length };
  } catch (err) {
    // Email failed: give the jobs back so the next run tries again
    await releaseClaim(user.id, claimed).catch(() => {});
    console.error(`[jobAlerts] email to ${user.id} failed:`, err.message);
    return { status: "failed", jobs: 0 };
  }
}

async function processPages(pages, jobs, opts) {
  const stats = { users: 0, emailed: 0, noMatch: 0, alreadySent: 0, failed: 0, jobsSent: 0, candidateJobs: jobs.length };
  for await (const users of pages) {
    for (const user of users) {
      stats.users += 1;
      try {
        const r = await alertOneUser(user, jobs, opts);
        if (r.status === "sent") { stats.emailed += 1; stats.jobsSent += r.jobs; }
        else if (r.status === "no_match") stats.noMatch += 1;
        else if (r.status === "already_sent") stats.alreadySent += 1;
        else stats.failed += 1;
      } catch (err) {
        stats.failed += 1;
        console.error(`[jobAlerts] user ${user.id} failed:`, err.message);
      }
    }
  }
  return stats;
}

// ── Public ───────────────────────────────────────────────────────────────────
export async function runJobAlerts(frequency) {
  if (!LOOKBACK_DAYS[frequency]) throw new Error(`Unknown frequency: ${frequency}`);

  const jobs = await fetchCandidateJobs(daysAgo(LOOKBACK_DAYS[frequency]));
  if (jobs.length === 0) return { frequency, users: 0, emailed: 0, candidateJobs: 0 };

  const { weekday } = lagosToday();
  const pages = userPages((q) => {
    q = q.eq("alert_frequency", frequency);
    return frequency === "weekly" ? q.eq("alert_day", weekday) : q;
  });

  const stats = await processPages(pages, jobs, { kind: "digest", urgent: false });
  return { frequency, ...stats };
}

// Same-day and urgent jobs, sent straight away whatever frequency was picked.
// Only people who switched on "Urgent job alerts" and chose at least one place.
export async function runUrgentAlerts() {
  const jobs = await fetchCandidateJobs(daysAgo(2), { urgentOnly: true });
  if (jobs.length === 0) return { urgent: true, users: 0, emailed: 0, candidateJobs: 0 };

  const pages = userPages((q) => q.eq("urgent_alerts", true).not("job_locations", "eq", "[]"));
  const stats = await processPages(pages, jobs, { kind: "urgent", urgent: true });
  return { urgent: true, ...stats };
}

// Dashboard: the same matcher, no email and no log
export async function getMatchesForUser(userId, { limit = 20, days = 14 } = {}) {
  const { data: user, error } = await supabase
    .from("user_profiles")
    .select(USER_SELECT)
    .eq("id", userId)
    .maybeSingle();
  if (error) throw error;
  if (!user) return [];

  const jobs = await fetchCandidateJobs(daysAgo(days));
  return matchJobsForUser(jobs, user, { limit });
}