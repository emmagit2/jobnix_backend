import "dotenv/config";
import twilio from "twilio";

console.log("FROM =", process.env.TWILIO_WHATSAPP_FROM);

const client = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);

client.messages
  .create({
    from: process.env.TWILIO_WHATSAPP_FROM,
    to: "whatsapp:+2349162645642",
    body: "Test from JobNix",
  })
  .then((m) => console.log("SENT", m.sid, m.status))
  .catch((e) => console.log("FAILED", e.code, e.message));