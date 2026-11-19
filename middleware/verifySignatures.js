// middleware/verifySignatures.js  (Twilio version)
import twilio from "twilio";

// Twilio signs each request with your Auth Token. The signature covers the
// exact public URL Twilio called plus the form fields, so the URL must match.
export function verifyWhatsappSignature(req, res, next) {
  const signature = req.headers["x-twilio-signature"];
  if (!signature) return res.sendStatus(403);

  // Use your public URL (ngrok while testing, your real domain in production).
  // Set PUBLIC_BASE_URL in .env, e.g. https://abc123.ngrok-free.app (no trailing slash).
  const base =
    process.env.PUBLIC_BASE_URL ||
    `${req.headers["x-forwarded-proto"] || req.protocol}://${req.headers["x-forwarded-host"] || req.get("host")}`;
  const url = base + req.originalUrl;

  const valid = twilio.validateRequest(
    process.env.TWILIO_AUTH_TOKEN,
    signature,
    url,
    req.body || {}
  );

  if (!valid) {
    console.error("[whatsapp webhook] invalid Twilio signature for", url);
    return res.sendStatus(403);
  }
  next();
}