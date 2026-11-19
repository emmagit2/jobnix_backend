// route/whatsapp.js  (Twilio version)
import express from "express";
import twilio from "twilio";
import requireAuth from "../middleware/requireAuth.js";
import requireBusinessAccount from "../middleware/requireBusinessAccount.js";
import {
  receiveMessage,
  requestPhoneVerification,
  confirmPhoneVerification,
} from "../controllers/whatsappController.js";
import { nudgeCronHandler } from "../services/loginNudgeService.js";

const router = express.Router();

// Daily inactive-owner nudge. Called by a cron service, not by Twilio or a logged-in user,
// so it has no Twilio signature and no login. The x-cron-secret header protects it.
router.post("/internal/nudges/run", nudgeCronHandler);

// Twilio posts inbound WhatsApp messages here as form data (not JSON).
// twilio.webhook() rejects any request not signed by Twilio.
// Set TWILIO_SKIP_SIGNATURE=true in .env ONLY for quick local debugging.
const twilioGuard =
  process.env.TWILIO_SKIP_SIGNATURE === "true"
    ? (req, res, next) => next()
    : twilio.webhook({ protocol: "https" });

router.post(
  "/webhook",
  express.urlencoded({ extended: false }),
  twilioGuard,
  receiveMessage
);

// "Connect WhatsApp" dashboard flow
router.post("/verify/request", [requireAuth, requireBusinessAccount], requestPhoneVerification);
router.post("/verify/confirm", [requireAuth, requireBusinessAccount], confirmPhoneVerification);

export default router;