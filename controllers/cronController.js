// controllers/cronController.js
import { supabase } from "../config/supabase.js";
import * as jobsRepo from "../lib/jobsRepo.js";
import * as notificationService from "../services/notificationService.js";
import * as jobAlertService from "../services/jobAlertService.js";

// External scheduler hits this every few hours.
// POST /api/cron/check-expiring-jobs   header: x-cron-secret: <CRON_SECRET>
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

// External scheduler hits this once a week.
// POST /api/cron/send-weekly-summaries   header: x-cron-secret: <CRON_SECRET>
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

// Job match emails for job seekers.
// POST /api/cron/send-job-alerts?frequency=instant|daily|weekly|monthly
//   header: x-cron-secret: <CRON_SECRET>
//
// Suggested schedule (Nigeria time, WAT = UTC+1):
//   instant  every 15 minutes
//   daily    every day at 07:00  (06:00 UTC)
//   weekly   every day at 07:00  (people are picked by their chosen day)
//   monthly  1st of the month at 07:00
const FREQUENCIES = ["instant", "daily", "weekly", "monthly"];

export async function sendJobAlerts(req, res) {
  try {
    const frequency = String(req.query.frequency || req.body?.frequency || "daily");
    if (!FREQUENCIES.includes(frequency)) {
      return res.status(400).json({ success: false, message: `frequency must be one of ${FREQUENCIES.join(", ")}` });
    }
    res.json(await jobAlertService.runJobAlerts(frequency));
  } catch (err) {
    console.error("[/api/cron/send-job-alerts] error:", err);
    res.status(500).json({ success: false, message: err.message || "Something went wrong." });
  }
}

// Same-day and urgent jobs, straight away.
// POST /api/cron/send-urgent-job-alerts   (run every 10 minutes)
export async function sendUrgentJobAlerts(req, res) {
  try {
    res.json(await jobAlertService.runUrgentAlerts());
  } catch (err) {
    console.error("[/api/cron/send-urgent-job-alerts] error:", err);
    res.status(500).json({ success: false, message: err.message || "Something went wrong." });
  }
}