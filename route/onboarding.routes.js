// routes/onboarding.js
// Mount this in your Express app: app.use("/api/onboarding", onboardingRouter)
//
// Assumes you already have auth middleware that verifies the user's Supabase
// JWT (sent as `Authorization: Bearer <access_token>` from the frontend) and
// attaches the decoded user to `req.user`. Adjust `requireAuth` below to
// match whatever you're already using.

import express from "express";
import { supabase } from "../lib/supabase.js"; // the service-role client you shared

const router = express.Router();

// --- auth middleware ---------------------------------------------------
// Verifies the bearer token against Supabase and attaches req.user.
async function requireAuth(req, res, next) {
  const authHeader = req.headers.authorization || "";
  const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null;
  if (!token) return res.status(401).json({ error: "Missing auth token" });

  const { data, error } = await supabase.auth.getUser(token);
  if (error || !data?.user) return res.status(401).json({ error: "Invalid or expired session" });

  req.user = data.user;
  next();
}

// --- POST /api/onboarding/jobseeker ------------------------------------
router.post("/jobseeker", requireAuth, async (req, res) => {
  const { employmentStatus, workType, roles, location } = req.body;

  // Basic validation — mirrors the DB check constraints so bad input fails
  // fast with a clear message instead of a raw Postgres error.
  const VALID_EMPLOYMENT = ["full_time", "part_time", "looking"];
  const VALID_WORK_TYPE = ["formal", "informal", "both"];

  if (!VALID_EMPLOYMENT.includes(employmentStatus)) {
    return res.status(400).json({ error: "Invalid employmentStatus" });
  }
  if (!VALID_WORK_TYPE.includes(workType)) {
    return res.status(400).json({ error: "Invalid workType" });
  }
  if (!Array.isArray(roles) || roles.length === 0) {
    return res.status(400).json({ error: "Pick at least one role" });
  }
  if (!location || typeof location !== "string") {
    return res.status(400).json({ error: "Location is required" });
  }

  const userId = req.user.id;

  // 1. Mark the account type + onboarded on the shared profiles table.
  const { error: profileError } = await supabase
    .from("profiles")
    .update({ account_type: "jobseeker", onboarded: true })
    .eq("id", userId);

  if (profileError) {
    return res.status(500).json({ error: "Failed to update profile", detail: profileError.message });
  }

  // 2. Upsert the job-seeker-specific fields onto user_profiles.
  const { error: userProfileError } = await supabase
    .from("user_profiles")
    .upsert({
      id: userId,
      employment_status: employmentStatus,
      work_type: workType,
      roles,
      location,
      profile_complete: true,
    });

  if (userProfileError) {
    return res.status(500).json({ error: "Failed to save job seeker details", detail: userProfileError.message });
  }

  return res.status(200).json({ ok: true });
});

export default router;