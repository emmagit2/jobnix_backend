// middleware/verifySignatures.js
import * as whatsappService from "../services/whatsappService.js";

// Requires req.rawBody to have been captured by the raw-body-preserving
// JSON parser (the express.json({ verify }) option — see integration README).
export function verifyWhatsappSignature(req, res, next) {
  const signature = req.headers["x-hub-signature-256"];
  if (!whatsappService.verifySignature(req.rawBody, signature)) {
    return res.sendStatus(401);
  }
  next();
}