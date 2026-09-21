 import express from "express";
import {
  getJobs,
  getJobById,
  createJob,
  updateJob,
  deleteJob,
  toggleFeaturedJob,
  incrementJobView,
  incrementJobClick,
  applyToJob,
  getMyJobs,
  getJobStats,
  getJobApplicants,
  submitInformalJob,
  confirmInformalJobPayment,
  getPendingJobs,
  approveJob,
  rejectJob,
  getMyInformalApplicants,
  updateApplicantStatus,
  openApplicantChat,
} from "../controllers/jobController.js";
import adminCheck from "../middleware/adminCheck.js";
import requireAuth from "../middleware/requireAuth.js";
import requireBusinessAccount from "../middleware/requireBusinessAccount.js";

const router = express.Router();

// =============================
// PUBLIC / BUSINESS ROUTES
// =============================
// Single-segment paths ("/mine", "/applicants", "/informal", "/pending") MUST
// all be registered before the generic "/:id" below — otherwise Express
// matches them as GET/POST /:id with id="mine"/"applicants"/... and the real
// handler never runs.

router.get("/mine", [requireAuth, requireBusinessAccount], getMyJobs);

// Business dashboard: every applicant across MY informal jobs, accept/reject
// one of them, and open an in-app chat with them.
router.get("/applicants", [requireAuth, requireBusinessAccount], getMyInformalApplicants);
router.patch("/applicants/:applicationId/status", [requireAuth, requireBusinessAccount], updateApplicantStatus);
router.post("/applicants/:applicationId/chat", [requireAuth, requireBusinessAccount], openApplicantChat);

// Business (or agent acting for a business) submits an informal job —
// always lands as status "pending" + payment_status "pending". Never goes
// live until payment is confirmed AND an admin approves it.
router.post("/informal", [requireAuth, requireBusinessAccount], submitInformalJob);

// Admin queue: informal jobs that are paid and awaiting review.
router.get("/pending", adminCheck, getPendingJobs);

router.get("/", getJobs);

// Job-seeker facing analytics — two-segment paths, no ordering conflict
// with "/:id" (different segment count), but grouped here for clarity.
router.get("/:id/view", incrementJobView); // call when job detail page loads
router.post("/:id/click", incrementJobClick); // call when "Apply" is clicked

// Requires a logged-in jobseeker account (applications.applicant_id is a real FK)
router.post("/:id/apply", requireAuth, applyToJob);

// Business dashboard: single job's stats card + who applied
router.get("/:id/stats", [requireAuth, requireBusinessAccount], getJobStats);
router.get("/:id/applicants", [requireAuth, requireBusinessAccount], getJobApplicants);

// Payment webhook callback — this should be called by your payment
// provider's server-to-server webhook, not directly from the client.
// If your webhook can't carry a business's auth token, swap requireAuth
// out for your webhook-signature verification middleware instead.
router.post("/:id/confirm-payment", confirmInformalJobPayment);

// Generic "/:id" LAST among single-segment GETs — must come after "/mine",
// "/applicants", "/informal", and "/pending" above.
router.get("/:id", getJobById);

// =============================
// ADMIN ROUTES
// =============================
// CREATE JOB (formal / admin / scraped — goes live immediately, unlike
// the business-facing "/informal" route above)
router.post("/", adminCheck, createJob);

// UPDATE JOB
router.put("/:id", adminCheck, updateJob);

// DELETE JOB
router.delete("/:id", adminCheck, deleteJob);

// TOGGLE FEATURED
router.patch("/:id/featured", adminCheck, toggleFeaturedJob);

// APPROVE / REJECT an informal job submission
router.patch("/:id/approve", adminCheck, approveJob);
router.patch("/:id/reject", adminCheck, rejectJob);

export default router;