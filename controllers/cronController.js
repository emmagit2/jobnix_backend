// controllers/cronController.js
import { supabase } from "../config/supabase.js";
import * as jobsRepo from "../lib/jobsRepo.js";
import * as notificationService from "../services/notificationService.js";

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