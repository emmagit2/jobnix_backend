import express from "express";
import { verifyTurnstile } from "../utils/turnstile.js";

const router = express.Router();

router.post("/verify", async (req, res) => {
  const { token } = req.body;

  if (!token) {
    return res.status(400).json({ error: "Token is required" });
  }

  const ip =
    req.headers["cf-connecting-ip"] ??
    req.headers["x-forwarded-for"]?.split(",")[0].trim() ??
    req.socket.remoteAddress ??
    null;

  const { ok, reason } = await verifyTurnstile(token, ip);

  if (!ok) {
    console.warn("Gate blocked:", reason);
    return res.status(403).json({ error: "Verification failed" });
  }

  return res.status(200).json({ verified: true });
});

export default router;