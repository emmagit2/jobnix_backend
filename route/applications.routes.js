import { Router } from "express";
import rateLimit from "express-rate-limit";
import requireAuth from "../middleware/requireAuth.js";
import adminCheck from "../middleware/adminCheck.js";
import {
  createApplication,
  confirmApplication,
  discardExternalApplication, // NEW
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

// Max 5 attempts per 10 minutes per IP, for the two routes that email or check codes
const codeLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { message: "Too many attempts. Please wait a few minutes and try again." },
});

// Applicant-facing: needs a signed-in user
router.post("/applications", requireAuth, createApplication);
router.get("/applications/me", requireAuth, getMyApplications); // must stay before any /:id route
router.get("/applications/job/:jobId", requireAuth, getApplicationForJob);
router.patch("/applications/:id/confirm", requireAuth, confirmApplication);
router.delete("/applications/:id", requireAuth, discardExternalApplication); // NEW: "No, I didn't apply"

// Admin dashboard: needs a signed-in admin (role check happens in adminCheck)
router.get("/admin/applications", adminCheck, getAllApplicationsAdmin);
router.get("/admin/jobs/:jobId/applications", adminCheck, getApplicationsForJobAdmin);
router.post("/admin/jobs/:jobId/recruiter-link", adminCheck, getOrCreateRecruiterLink);

// Public recruiter view
router.get("/recruiter-view/:token", getRecruiterView);
router.post("/recruiter-view/:token/request-code", codeLimiter, requestRecruiterCode);
router.post("/recruiter-view/:token/verify-code", codeLimiter, verifyRecruiterCode);
router.get("/recruiter-view/:token/applications", getRecruiterApplications);

export default router;