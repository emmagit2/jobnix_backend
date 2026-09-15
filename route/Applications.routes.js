import { Router } from "express";
import requireAuth from "../middleware/requireAuth.js";
import adminCheck from "../middleware/adminCheck.js";
import {
  createApplication,
  getApplicationForJob,
  getMyApplications,
  getAllApplicationsAdmin,
  getApplicationsForJobAdmin,
  getOrCreateRecruiterLink,
  getRecruiterView,
  requestRecruiterCode,
  verifyRecruiterCode,
  getRecruiterApplications,
} from "../controllers/applications.controller.js";

const router = Router();

// Applicant-facing — needs a signed-in user
router.post("/applications", requireAuth, createApplication);
router.get("/applications/job/:jobId", requireAuth, getApplicationForJob);
router.get("/applications/me", requireAuth, getMyApplications);

// Admin dashboard — needs a signed-in admin (role check happens in adminCheck)
router.get("/admin/applications", adminCheck, getAllApplicationsAdmin);
router.get("/admin/jobs/:jobId/applications", adminCheck, getApplicationsForJobAdmin);
router.post("/admin/jobs/:jobId/recruiter-link", adminCheck, getOrCreateRecruiterLink);

// Public — the token only confirms the link is valid and that the job is
// still one-click apply; a code emailed to recruiter_email is required to
// actually see applicants. Only ever works for apply_method = 'platform'
// jobs — see the apply_method checks inside each controller.
router.get("/recruiter-view/:token", getRecruiterView);
router.post("/recruiter-view/:token/request-code", requestRecruiterCode);
router.post("/recruiter-view/:token/verify-code", verifyRecruiterCode);
router.get("/recruiter-view/:token/applications", getRecruiterApplications);

export default router;