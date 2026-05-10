import express from "express";
import {
  jobClickController,
  analyticsOverviewController,
} from "../controllers/analytics.controller.js";
import { cookieMiddleware } from "../middleware/cookie.middleware.js";

const router = express.Router();

// track click
router.post("/job-click", cookieMiddleware, jobClickController);

// analytics overview
router.get("/overview", analyticsOverviewController);

export default router;