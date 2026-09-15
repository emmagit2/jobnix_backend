import express from "express";
import requireAuth from "../middleware/requireAuth.js";
import requireBusinessAccount from "../middleware/requireBusinessAccount.js";
import * as ctrl from "../controllers/paymentController.js";

const router = express.Router();

router.post("/initialize", requireAuth, requireBusinessAccount, ctrl.initializeJobPayment);
router.post("/informal-job/initialize", requireAuth, requireBusinessAccount, ctrl.initializeInformalJobPayment);
router.get("/status", requireAuth, requireBusinessAccount, ctrl.getPaymentStatus);
router.post("/premium/initialize", requireAuth, requireBusinessAccount, ctrl.initializePremiumUpgrade);
router.get("/callback", ctrl.handleCallback);
router.post("/webhook", ctrl.handleWebhook);

export default router;