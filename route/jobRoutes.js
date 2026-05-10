import express from "express";

import {
  getJobs,
  getJobById,
  createJob,
  updateJob,
  deleteJob,
  toggleFeaturedJob,
} from "../controllers/jobController.js";

import adminCheck from "../middleware/adminCheck.js";

const router = express.Router();

// =============================
// PUBLIC ROUTES
// =============================
router.get("/", getJobs);

router.get("/:id", getJobById);


// =============================
// ADMIN ROUTES
// =============================

// CREATE JOB
router.post("/", adminCheck, createJob);

// UPDATE JOB
router.put("/:id", adminCheck, updateJob);

// DELETE JOB
router.delete("/:id", adminCheck, deleteJob);

// TOGGLE FEATURED
router.patch("/:id/featured", adminCheck, toggleFeaturedJob);

export default router;