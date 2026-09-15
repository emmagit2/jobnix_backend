// routes/whatsapp.js
import express from "express";
import { verifyWhatsappSignature } from "../middleware/verifySignatures.js";
import requireAuth from "../middleware/requireAuth.js";
import requireBusinessAccount from "../middleware/requireBusinessAccount.js";
import {
  verifyWebhook,
  receiveMessage,
  requestPhoneVerification,
  confirmPhoneVerification,
} from "../controllers/whatsappController.js";

const router = express.Router();

router.get("/webhook", verifyWebhook); // Meta's one-time setup handshake
router.post("/webhook", verifyWhatsappSignature, receiveMessage); // inbound messages

// "Connect WhatsApp" dashboard flow — OTP against business_profiles.phone
router.post("/verify/request", [requireAuth, requireBusinessAccount], requestPhoneVerification);
router.post("/verify/confirm", [requireAuth, requireBusinessAccount], confirmPhoneVerification);

export default router;