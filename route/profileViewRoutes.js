import express from "express";
import requireAuth from "../middleware/requireAuth.js";
import {
  generateProfileViewLink,
  getProfileByToken,
  streamProfileCv,
  checkUsernameAvailable,
  setUsername,
  getProfileByUsername,
  streamProfileCvByUsername,
} from "../controllers/profileView.controller.js";

const router = express.Router();

// Jobseeker (signed in) generates their own shareable TOKEN link
// (used for recruiter-application emails — unrelated to the username link)
router.post("/profile-view/generate", requireAuth, generateProfileViewLink);

// Username claiming — signed in
router.get("/profile-view/username-available/:username", checkUsernameAvailable);
router.patch("/profile-view/username", requireAuth, setUsername);

// Public — username-based profile link (jobnix.ng/u/username)
router.get("/profile-view/u/:username", getProfileByUsername);
router.get("/profile-view/u/:username/cv", streamProfileCvByUsername);

// Public — legacy token-based view (still used for recruiter emails)
router.get("/profile-view/:token", getProfileByToken);
router.get("/profile-view/:token/cv", streamProfileCv);

export default router;