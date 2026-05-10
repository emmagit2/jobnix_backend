import express from "express";
import { trackJobClick, getAllClicks } from "../services/analytics.service.js";

const router = express.Router();

// ✅ TRACK CLICK
router.post("/job-click", async (req, res) => {
  try {
    const result = await trackJobClick(req.body);

    res.status(201).json({
      success: true,
      data: result,
    });
  } catch (error) {
    console.log(error);

    res.status(500).json({
      success: false,
      message: error.message,
    });
  }
});

// ✅ GET ALL CLICKS
router.get("/clicks", async (req, res) => {
  try {
    const data = await getAllClicks();

    res.json({
      success: true,
      data,
    });
  } catch (error) {
    console.log(error);

    res.status(500).json({
      success: false,
      message: error.message,
    });
  }
});

export default router;