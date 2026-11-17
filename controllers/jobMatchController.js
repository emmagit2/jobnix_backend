// controllers/jobMatchController.js
//
// Dashboard "Jobs for you" list. Uses the same matcher as the emails, so
// what people see here is what lands in their inbox.
//
// GET /api/jobs/matched?limit=20
// Assumes your auth middleware sets req.user.id (change if yours differs).

import * as jobAlertService from "../services/jobAlertService.js";

export async function getMyMatchedJobs(req, res) {
  try {
    const userId = req.user?.id;
    if (!userId) return res.status(401).json({ success: false, message: "Please sign in." });

    const limit = Math.min(Number(req.query.limit) || 20, 50);
    const matches = await jobAlertService.getMatchesForUser(userId, { limit });

    res.json({
      success: true,
      jobs: matches.map(({ job, score, reasons }) => ({ ...job, match_score: score, match_reasons: reasons })),
    });
  } catch (err) {
    console.error("[/api/jobs/matched] error:", err);
    res.status(500).json({ success: false, message: err.message || "Something went wrong." });
  }
}