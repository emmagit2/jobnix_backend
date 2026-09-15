// controllers/whatsappController.js
import { supabase } from "../config/supabase.js";
import * as whatsappService from "../services/whatsappService.js";
import * as geminiService from "../services/geminiService.js";
import * as businessProfilesRepo from "../lib/businessProfilesRepo.js";

// Meta calls this once, at setup time, to confirm you own the webhook URL.
export const verifyWebhook = (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode === "subscribe" && token === process.env.WHATSAPP_VERIFY_TOKEN) {
    return res.status(200).send(challenge);
  }
  return res.sendStatus(403);
};

// Meta POSTs every inbound message/status update here.
export const receiveMessage = async (req, res) => {
  const inbound = whatsappService.extractInboundMessage(req.body);

  res.sendStatus(200); // always ack immediately so Meta doesn't retry
  if (!inbound) return;

  try {
    // ── 1. Check if this is a pending phone-verification code first ──
    // A business waiting to verify sent us their code as a plain WhatsApp
    // text. We match on phone_verification_code, not on phone — the
    // business hasn't been linked to this wa_id yet at this point, that's
    // literally what we're establishing here.
    const trimmedText = inbound.text.trim();
    if (trimmedText) {
      const pendingBusiness = await businessProfilesRepo.findByPendingCode(trimmedText);
      if (pendingBusiness) {
        const { error: verifyErr } = await supabase
          .from("business_profiles")
          .update({
            phone: `+${inbound.from}`,
            phone_verified: true,
            phone_verified_at: new Date().toISOString(),
            phone_verification_code: null,
          })
          .eq("id", pendingBusiness.id);

        if (verifyErr) throw verifyErr;

        await whatsappService.sendText(
          inbound.from,
          "✅ Your WhatsApp number is now verified for JobNix. You'll receive applicant messages here."
        );
        return;
      }
    }

    // ── 2. Not a verification code — treat as a normal business-question message ──
    const business = await businessProfilesRepo.findByPhone(`+${inbound.from}`);

    if (!business) {
      await whatsappService.sendText(
        inbound.from,
        "This WhatsApp number isn't linked to a verified JobNix business account yet. " +
          "Please add and verify your phone number from your Business Dashboard settings."
      );
      return;
    }

    const { data: recentRows, error: recentErr } = await supabase
      .from("ai_conversations")
      .select("*")
      .eq("whatsapp_number", inbound.from)
      .order("created_at", { ascending: false })
      .limit(10);
    if (recentErr) throw recentErr;

    const history = recentRows
      .reverse()
      .map((m) => ({ role: m.role === "assistant" ? "model" : "user", parts: [{ text: m.text }] }));

    const reply = await geminiService.answerBusinessQuestion(business.id, inbound.text, history);

    await whatsappService.sendText(inbound.from, reply);

    await supabase
      .from("ai_conversations")
      .insert({ business_id: business.id, whatsapp_number: inbound.from, role: "user", text: inbound.text });
    await supabase
      .from("ai_conversations")
      .insert({ business_id: business.id, whatsapp_number: inbound.from, role: "assistant", text: reply });
  } catch (err) {
    console.error("[whatsapp] failed to handle inbound message:", err);
    // Don't let a second WhatsApp send failure crash the process —
    // this branch already failed once; a nested failure here should
    // just log, not throw unhandled.
    try {
      await whatsappService.sendText(
        inbound.from,
        "Sorry, something went wrong looking that up. Please try again shortly."
      );
    } catch (sendErr) {
      console.error("[whatsapp] fallback send also failed:", sendErr);
    }
  }
};

// Generates a code for the business to SEND to JobNix's WhatsApp number —
// we do NOT send anything outbound here anymore. This sidesteps the
// WhatsApp 24-hour session window entirely, since the business messaging
// us first is what opens that window (and satisfies verification in the
// same act).
export const requestPhoneVerification = async (req, res) => {
  const { phone } = req.body; // E.164, e.g. +2348012345678 — kept for display/record only
  if (!phone || !/^\+\d{8,15}$/.test(phone)) {
    return res.status(400).json({ success: false, message: "phone must be in E.164 format, e.g. +2348012345678" });
  }

  const code = String(Math.floor(100000 + Math.random() * 900000));

  const { error } = await supabase
    .from("business_profiles")
    .update({ phone, phone_verified: false, phone_verification_code: code })
    .eq("id", req.businessId);
  if (error) return res.status(500).json({ success: false, message: error.message });

  res.json({
    success: true,
    code,
    sendToNumber: process.env.WHATSAPP_DISPLAY_NUMBER || "+1 555-677-8913",
  });
};

// Now just a status check — the actual verification happens inside
// receiveMessage above when the business's WhatsApp text arrives. The
// frontend polls this after showing the code, to know when to flip to the
// "verified" screen.
export const confirmPhoneVerification = async (req, res) => {
  const { data: business, error } = await supabase
    .from("business_profiles")
    .select("phone_verified, phone")
    .eq("id", req.businessId)
    .single();
  if (error) return res.status(500).json({ success: false, message: error.message });

  if (!business.phone_verified) {
    return res.status(400).json({ success: false, message: "Not verified yet — send the code via WhatsApp first." });
  }

  res.json({ success: true, verified: true, phone: business.phone });
};