// services/whatsappService.js  (Twilio version)
import twilio from "twilio";

const client = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
const FROM = process.env.TWILIO_WHATSAPP_FROM; // e.g. "whatsapp:+14155238886"

// Twilio sends form fields: From = "whatsapp:+2348012345678", Body = text.
// Returns the same shape the controller already expects (digits-only `from`).
export function extractInboundMessage(body) {
  if (!body?.From) return null;
  return {
    from: body.From.replace("whatsapp:+", ""),
    text: body.Body || "",
    messageId: body.MessageSid || null,
    profileName: body.ProfileName || null,
  };
}

// `to` is digits only, e.g. "2348012345678".
export async function sendText(to, text) {
  try {
    return await client.messages.create({
      from: FROM,
      to: `whatsapp:+${to}`,
      body: String(text).slice(0, 1500), // Twilio caps body at 1600 chars
    });
  } catch (err) {
    console.error("[whatsappService] send failed:", err.message);
    throw err;
  }
}