// middleware/verifySignatures.js
import * as whatsappService from "../services/whatsappService.js";

// Requires req.rawBody to have been captured by the raw-body-preserving
// JSON parser (the express.json({ verify }) option — see integration README).
export function verifyWhatsappSignature(req, res, next) {
  const signature = req.headers["x-hub-signature-256"];

  // TEMPORARY DEBUG LOGGING — remove once the webhook is confirmed working.
  console.log("[whatsapp webhook] incoming signature header:", signature || "(missing)");
  console.log("[whatsapp webhook] rawBody present:", !!req.rawBody, "length:", req.rawBody?.length);
  console.log("[whatsapp webhook] APP_SECRET loaded:", !!process.env.WHATSAPP_APP_SECRET);

  const valid = whatsappService.verifySignature(req.rawBody, signature);
  console.log("[whatsapp webhook] signature valid:", valid);

  if (!valid) {
    return res.sendStatus(401);
  }
  next();
}