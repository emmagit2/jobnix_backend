// route/referralRoutes.js
import express from "express";
import { getMyReferralCode, getReferralStats, attachReferral } from "../controllers/referralController.js";
import requireAuth from "../middleware/RequireAuth.js";

const router = express.Router();

router.get("/my-code", requireAuth, getMyReferralCode);
router.get("/stats", requireAuth, getReferralStats);

// No auth here — this runs right after a new business signs up via jobnix.com/r/CODE,
// before they necessarily have a session yet. If your signup flow issues a token
// immediately, you can move this behind requireAuth instead.
router.post("/signup", attachReferral);

export default router;