// services/whatsappService.js
import crypto from "crypto";

const GRAPH_VERSION = "v26.0";
const PHONE_NUMBER_ID = process.env.WHATSAPP_PHONE_NUMBER_ID;
const ACCESS_TOKEN = process.env.WHATSAPP_ACCESS_TOKEN;
const APP_SECRET = process.env.WHATSAPP_APP_SECRET;

// Sends a plain text WhatsApp message via the Cloud API. `to` must be
// digits only, no leading "+" — e.g. "2348012345678" — matching the wa_id
// format Meta uses on both the send side and inbound webhook payloads.
export async function sendText(to, body) {
  const res = await fetch(`https://graph.facebook.com/${GRAPH_VERSION}/${PHONE_NUMBER_ID}/messages`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${ACCESS_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      messaging_product: "whatsapp",
      to,
      type: "text",
      text: { body },
    }),
  });

  const data = await res.json();
  if (!res.ok) {
    console.error("[whatsappService] send failed:", data);
    throw new Error(data?.error?.message || "Failed to send WhatsApp message");
  }
  return data;
}

// Pulls the first inbound text message out of Meta's webhook payload, or
// null if this particular call was a status update (sent/delivered/read
// receipts) rather than a new message — those fire constantly and aren't
// something receiveMessage needs to act on.
export function extractInboundMessage(body) {
  try {
    const value = body?.entry?.[0]?.changes?.[0]?.value;
    const message = value?.messages?.[0];
    if (!message) return null; // status update, not a new message

    return {
      from: message.from, // wa_id, digits only e.g. "2348012345678"
      text: message.text?.body || "",
      type: message.type,
      messageId: message.id,
      timestamp: message.timestamp,
      profileName: value?.contacts?.[0]?.profile?.name || null,
    };
  } catch (err) {
    console.error("[whatsappService] failed to parse inbound payload:", err);
    return null;
  }
}

// Verifies Meta's X-Hub-Signature-256 header against the raw request body
// using the APP SECRET (not the access token). req.rawBody must be the
// exact bytes Meta sent — see index.js's express.json({ verify }) option.
// Re-serializing req.body to JSON and hashing that instead would produce a
// different signature and always fail, even for a genuine request.
export function verifySignature(rawBody, signatureHeader) {
  if (!signatureHeader || !rawBody) return false;

  const expected = "sha256=" + crypto.createHmac("sha256", APP_SECRET).update(rawBody).digest("hex");

  const a = Buffer.from(expected);
  const b = Buffer.from(signatureHeader);
  if (a.length !== b.length) return false; // mismatched length -> definitely not equal
  return crypto.timingSafeEqual(a, b);
}