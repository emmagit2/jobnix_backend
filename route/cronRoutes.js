// route/cronRoutes.js
import express from "express";
import crypto from "crypto";
import {
  checkExpiringJobs,
  sendWeeklySummaries,
  sendJobAlerts,
  sendUrgentJobAlerts,
} from "../controllers/cronController.js";

const router = express.Router();

// Accepts "x-cron-secret: <secret>" or "Authorization: Bearer <secret>"
function verifyCronSecret(req, res, next) {
  const expected = process.env.CRON_SECRET;
  const bearer = (req.headers.authorization || "").replace(/^Bearer\s+/i, "");
  const given = req.headers["x-cron-secret"] || bearer;

  const a = Buffer.from(String(given || ""));
  const b = Buffer.from(String(expected || ""));
  if (!expected || a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    return res.status(401).json({ success: false, message: "Unauthorized" });
  }
  next();
}

// Existing routes (unchanged paths)
router.post("/check-expiring-jobs", verifyCronSecret, checkExpiringJobs);
router.post("/send-weekly-summaries", verifyCronSecret, sendWeeklySummaries);

// Job alert routes: GET and POST both work, so cron-job.org's GET is fine
router.all("/send-job-alerts", verifyCronSecret, sendJobAlerts);
router.all("/send-urgent-job-alerts", verifyCronSecret, sendUrgentJobAlerts);

export default router;