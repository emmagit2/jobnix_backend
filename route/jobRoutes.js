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
  updateInformalJob,
  deleteInformalJob,
  confirmInformalJobPayment,
  getPendingJobs,
  approveJob,
  rejectJob,
  getMyInformalApplicants,
  updateApplicantStatus,
  openApplicantChat,
  getMyInformalJobsAnalytics,
  applyByEmail,
  saveMyCv,
  saveAdminDraft,
  getAdminDrafts,
  getAdminDraftById,
  publishAdminDraft,
  deleteAdminDraft,
} from "../controllers/jobController.js";
import adminCheck from "../middleware/adminCheck.js";
import requireAuth from "../middleware/requireAuth.js";
import requireBusinessAccount from "../middleware/requireBusinessAccount.js";

const router = express.Router();

// =============================
// PUBLIC / BUSINESS ROUTES
// =============================
// Single-segment paths ("/mine", "/applicants", "/analytics", "/informal",
// "/pending", "/drafts") MUST all be registered before the generic "/:id"
// below — otherwise Express matches them as GET/POST /:id with
// id="mine"/"applicants"/"analytics"/"drafts"... and the real handler never runs.

router.get("/mine", [requireAuth, requireBusinessAccount], getMyJobs);

// Business dashboard: every applicant across MY informal jobs, accept/reject
// one of them, and open an in-app chat with them.
router.get("/applicants", [requireAuth, requireBusinessAccount], getMyInformalApplicants);
router.patch("/applicants/:applicationId/status", [requireAuth, requireBusinessAccount], updateApplicantStatus);
router.post("/applicants/:applicationId/chat", [requireAuth, requireBusinessAccount], openApplicantChat);

// Business dashboard: analytics (views/clicks/applications + applicant
// locations) for MY informal jobs only.
router.get("/analytics", [requireAuth, requireBusinessAccount], getMyInformalJobsAnalytics);

// Business (or agent acting for a business) submits an informal job —
// always lands as status "pending" + payment_status "pending". Never goes
// live until payment is confirmed AND an admin approves it.
router.post("/informal", [requireAuth, requireBusinessAccount], submitInformalJob);

// Business: edit or delete ONE of their own informal jobs. Ownership is
// checked inside the controller (submitted_by_business_id === req.businessId).
router.patch("/informal/:id", [requireAuth, requireBusinessAccount], updateInformalJob);
router.delete("/informal/:id", [requireAuth, requireBusinessAccount], deleteInformalJob);

// Admin queue: informal jobs that are paid and awaiting review.
router.get("/pending", adminCheck, getPendingJobs);

// Admin drafts — MUST come before any "/:id" route.
// requireAuth sets req.userId (used for drafted_by / approved_by);
// adminCheck confirms the user is an admin.
router.post("/drafts",             requireAuth, adminCheck, saveAdminDraft);
router.get("/drafts",              requireAuth, adminCheck, getAdminDrafts);
router.get("/drafts/:id",          requireAuth, adminCheck, getAdminDraftById);
router.post("/drafts/:id/publish", requireAuth, adminCheck, publishAdminDraft);
router.delete("/drafts/:id",       requireAuth, adminCheck, deleteAdminDraft);

router.get("/", getJobs);

router.get("/:id/view", incrementJobView); // call when job detail page loads
router.post("/:id/click", incrementJobClick); // call when "Apply" is clicked

// Requires a logged-in jobseeker account (applications.applicant_id is a real FK)
router.post("/:id/apply", requireAuth, applyToJob);
router.post("/:id/apply-email", requireAuth, applyByEmail);
router.post("/my-cv", requireAuth, saveMyCv);

// Business dashboard: single job's stats card + who applied
router.get("/:id/stats", [requireAuth, requireBusinessAccount], getJobStats);
router.get("/:id/applicants", [requireAuth, requireBusinessAccount], getJobApplicants);

// Payment webhook callback — should be called by your payment provider's
// server-to-server webhook, not directly from the client.
router.post("/:id/confirm-payment", confirmInformalJobPayment);

// Generic "/:id" LAST among single-segment GETs.
router.get("/:id", getJobById);

// =============================
// ADMIN ROUTES
// =============================
// CREATE JOB (formal / admin / scraped — goes live immediately)
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