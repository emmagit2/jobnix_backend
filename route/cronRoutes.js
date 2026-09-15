// routes/cronRoutes.js
import express from "express";
import { checkExpiringJobs, sendWeeklySummaries } from "../controllers/cronController.js";

const router = express.Router();

// Simple shared-secret check so only your scheduler can hit these endpoints
function verifyCronSecret(req, res, next) {
  const secret = req.headers["x-cron-secret"];
  if (!secret || secret !== process.env.CRON_SECRET) {
    return res.status(401).json({ success: false, message: "Unauthorized" });
  }
  next();
}

router.post("/check-expiring-jobs", verifyCronSecret, checkExpiringJobs);
router.post("/send-weekly-summaries", verifyCronSecret, sendWeeklySummaries);

export default router;