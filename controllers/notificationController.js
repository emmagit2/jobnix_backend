// controllers/notificationController.js
import * as prefsRepo from "../lib/notificationPreferencesRepo.js";

// GET /api/notifications/preferences
export async function getPreferences(req, res) {
  try {
    const prefs = await prefsRepo.get(req.businessId);
    res.json(toClientShape(prefs));
  } catch (err) {
    console.error("[/api/notifications/preferences GET] error:", err);
    res.status(500).json({ success: false, message: err.message || "Something went wrong." });
  }
}

// PUT /api/notifications/preferences — the "Save Preferences" button
export async function savePreferences(req, res) {
  try {
    const prefs = await prefsRepo.update(req.businessId, {
      new_applicant: req.body.newApplicant,
      job_expiring_soon: req.body.jobExpiringSoon,
      messages: req.body.messages,
      weekly_summary: req.body.weeklySummary,
    });
    res.json(toClientShape(prefs));
  } catch (err) {
    console.error("[/api/notifications/preferences PUT] error:", err);
    res.status(500).json({ success: false, message: err.message || "Something went wrong." });
  }
}

function toClientShape(prefs) {
  return {
    newApplicant: prefs.new_applicant,
    jobExpiringSoon: prefs.job_expiring_soon,
    messages: prefs.messages,
    weeklySummary: prefs.weekly_summary,
  };
}