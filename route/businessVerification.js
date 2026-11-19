 // route/businessVerification.js
import { Router } from "express";
import rateLimit from "express-rate-limit";
import requireAuth from "../middleware/requireAuth.js";
import { verifyBusinessNIN } from "../controllers/businessVerificationController.js";

const router = Router();

const ninLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 5, // 5 attempts per hour per user, since each call may be billed
  keyGenerator: (req) => req.userId,
  validate: { xForwardedForHeader: false },
  message: { success: false, message: "Too many attempts. Try again in an hour." },
});

router.post("/nin/verify", requireAuth, ninLimiter, verifyBusinessNIN);

export default router;