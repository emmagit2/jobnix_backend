import express from "express";
import requireAuth from "../middleware/requireAuth.js";
import requireBusinessAccount from "../middleware/requireBusinessAccount.js";
import * as ctrl from "../controllers/accountController.js";

const router = express.Router();

// No signup/login here — your frontend already authenticates via Supabase
// Auth; these just read/manage the business_profiles row for that session.
router.get("/", requireAuth, requireBusinessAccount, ctrl.getAccount);
router.delete("/", requireAuth, requireBusinessAccount, ctrl.deleteAccount);
router.get("/referrals", requireAuth, requireBusinessAccount, ctrl.getReferralStats);
router.post("/apply-referral", requireAuth, requireBusinessAccount, ctrl.applyReferral);

export default router;