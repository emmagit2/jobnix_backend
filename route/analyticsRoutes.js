import express from "express";
import {
  jobClickController,
  analyticsOverviewController,
} from "../controllers/analytics.controller.js";

const router = express.Router();

router.post("/job-click", jobClickController);
router.get("/clicks", analyticsOverviewController);

export default router;