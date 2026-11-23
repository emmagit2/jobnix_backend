 import express from "express";
import {
  getJobs,
  getJobCounts, // NEW: real totals for the dashboard
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
// Job seeker applies to an informal job on Jobnix; business takes an informal job down.
import {
  applyToInformalJob,
  getMyInformalApplications,
  setInformalJobTakenDown,
} from "../controllers/informalJobs.controller.js";
import adminCheck from "../middleware/adminCheck.js";
import requireAuth from "../middleware/requireAuth.js";
import requireBusinessAccount from "../middleware/requireBusinessAccount.js";

const router = express.Router();

// =============================
// PUBLIC / BUSINESS ROUTES
// =============================
// Single-segment paths ("/mine", "/applicants", "/analytics", "/informal",
// "/pending", "/drafts", "/counts", "/my-informal-applications") MUST all be
// registered before the generic "/:id" below — otherwise Express matches them
// as GET/POST /:id with id="mine"/"applicants"/"analytics"/"drafts"/"counts"...
// and the real handler never runs.

router.get("/mine", [requireAuth, requireBusinessAccount], getMyJobs);

// Real job totals (total / active / expired / featured) — not limited to 1000.
// MUST stay above "/:id".
router.get("/counts", getJobCounts);

// Job seeker: the informal jobs I applied for (powers the Applied marks on the My CV page).
router.get("/my-informal-applications", requireAuth, getMyInformalApplications);

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
// live until payment is confirmed (Paystack, via the payments routes) AND
// an admin approves it.
router.post("/informal", [requireAuth, requireBusinessAccount], submitInformalJob);

// Business: edit or delete ONE of their own informal jobs. Ownership is
// checked inside the controller (submitted_by_business_id === req.businessId).
router.patch("/informal/:id", [requireAuth, requireBusinessAccount], updateInformalJob);
router.delete("/informal/:id", [requireAuth, requireBusinessAccount], deleteInformalJob);

// Business: take an informal job down (people can no longer apply) or put it back up.
// Ownership is checked inside the controller.
router.patch("/informal/:id/takedown", [requireAuth, requireBusinessAccount], setInformalJobTakenDown);

// Job seeker: apply to an informal job on Jobnix. The application goes to the
// business that posted it. (Informal jobs never use email or an outside link.)
router.post("/informal/:id/apply", requireAuth, applyToInformalJob);

// Admin queue: informal jobs that are paid and awaiting review.
router.get("/pending", requireAuth, adminCheck, getPendingJobs);

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

// NOTE: payment confirmation is NOT handled here. Paystack's callback and
// webhook go through the payments routes (paymentController.js), which mark
// informal jobs as paid via jobsRepo.markInformalJobPaid.

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

// APPROVE / REJECT an informal job submission.
// requireAuth first so req.userId is set (approveJob saves it as approved_by).
router.patch("/:id/approve", requireAuth, adminCheck, approveJob);
router.patch("/:id/reject", requireAuth, adminCheck, rejectJob);

export default router;