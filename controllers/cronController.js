// controllers/cronController.js
import { supabase } from "../config/supabase.js";
import * as jobsRepo from "../lib/jobsRepo.js";
import * as notificationService from "../services/notificationService.js";
import * as jobAlertService from "../services/jobAlertService.js";

// ── Business notifications (unchanged) ───────────────────────────────────────

// POST /api/cron/check-expiring-jobs
export async function checkExpiringJobs(req, res) {
  try {
    const jobs = await jobsRepo.findExpiringSoon(3); // deadline within 3 days, not yet notified
    let notified = 0;
    for (const job of jobs) {
      const businessId = await jobsRepo.resolveBusinessIdForJob(job);
      if (businessId) {
        await notificationService.notifyJobExpiringSoon(businessId, job.title, job.deadline);
        notified += 1;
      }
      await jobsRepo.markDeadlineNotified(job.id);
    }
    res.json({ notified });
  } catch (err) {
    console.error("[/api/cron/check-expiring-jobs] error:", err);
    res.status(500).json({ success: false, message: err.message || "Something went wrong." });
  }
}

// POST /api/cron/send-weekly-summaries
export async function sendWeeklySummaries(req, res) {
  try {
    const { data: businesses, error } = await supabase
      .from("business_profiles")
      .select("id, phone, phone_verified")
      .not("phone", "is", null)
      .eq("phone_verified", true);
    if (error) throw error;

    let sent = 0;
    for (const business of businesses) {
      const jobs = await jobsRepo.listByBusiness(business.id);
      if (jobs.length === 0) continue;

      const totals = jobs.reduce(
        (acc, j) => ({
          views: acc.views + j.view_count,
          clicks: acc.clicks + j.click_count,
          applications: acc.applications + j.application_count,
        }),
        { views: 0, clicks: 0, applications: 0 }
      );

      const summary =
        `${jobs.length} job(s) posted\n` +
        `👀 ${totals.views} views\n` +
        `🖱️ ${totals.clicks} clicks\n` +
        `📝 ${totals.applications} applications`;

      await notificationService.notifyWeeklySummary(business.id, summary);
      sent += 1;
    }
    res.json({ sent });
  } catch (err) {
    console.error("[/api/cron/send-weekly-summaries] error:", err);
    res.status(500).json({ success: false, message: err.message || "Something went wrong." });
  }
}

// ── Job seeker alerts ────────────────────────────────────────────────────────
//
// GET or POST /api/cron/send-job-alerts?frequency=instant|daily|weekly|monthly
// GET or POST /api/cron/send-urgent-job-alerts
//
// Testing: add &dry=1 (log only, no emails, nothing marked as sent)
//          and &only=you@email.com (just that one user)
//
// Schedule (Africa/Lagos):
//   instant  every 15 minutes
//   daily    every day 07:00
//   weekly   every day 07:00 (people are picked by their chosen day)
//   monthly  1st of the month 07:00
//   urgent   every 15 minutes
const FREQUENCIES = ["instant", "daily", "weekly", "monthly"];

// Reply straight away and work in the background, so the scheduler never
// times out. A run that is still going is not started twice.
const running = new Set();

function runInBackground(key, fn, res) {
  if (running.has(key)) return res.json({ success: true, skipped: "already running" });
  running.add(key);
  res.status(202).json({ success: true, started: key });
  fn()
    .then((r) => console.log(`[cron:${key}]`, JSON.stringify(r)))
    .catch((e) => console.error(`[cron:${key}] failed:`, e))
    .finally(() => running.delete(key));
}

const testOptions = (req) => ({
  dry: req.query.dry === "1",
  only: req.query.only ? String(req.query.only).trim() : null,
});

export async function sendJobAlerts(req, res) {
  const frequency = String(req.query.frequency || req.body?.frequency || "daily");
  if (!FREQUENCIES.includes(frequency)) {
    return res
      .status(400)
      .json({ success: false, message: `frequency must be one of ${FREQUENCIES.join(", ")}` });
  }
  runInBackground(frequency, () => jobAlertService.runJobAlerts(frequency, testOptions(req)), res);
}

export async function sendUrgentJobAlerts(req, res) {
  runInBackground("urgent", () => jobAlertService.runUrgentAlerts(testOptions(req)), res);
}