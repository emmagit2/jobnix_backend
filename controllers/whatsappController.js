// controllers/whatsappController.js  (Twilio version, sandbox-safe replies)
import crypto from "crypto";
import twilio from "twilio";
import { supabase } from "../config/supabase.js";
import * as whatsappService from "../services/whatsappService.js";
import * as geminiService from "../services/geminiService.js";
import * as businessProfilesRepo from "../lib/businessProfilesRepo.js";

// "twiml": replies go back inside the webhook response (works in the Twilio sandbox).
// "rest":  replies are sent through the Twilio REST API (use with a real WhatsApp sender).
const REPLY_MODE = process.env.TWILIO_REPLY_MODE || "twiml";

export const receiveMessage = async (req, res) => {
  console.log("[whatsapp] webhook hit:", req.body?.Body);
  const inbound = whatsappService.extractInboundMessage(req.body);

  const outbox = [];
  let responded = false;

  const respond = () => {
    if (responded) return;
    responded = true;
    if (REPLY_MODE === "twiml") {
      const twiml = new twilio.twiml.MessagingResponse();
      outbox.forEach((t) => twiml.message(String(t).slice(0, 1500)));
      res.type("text/xml").send(twiml.toString());
    } else {
      res.type("text/xml").send("<Response/>");
    }
  };

  // Queue a reply (twiml mode) or send it right away (rest mode).
  const reply = async (text) => {
    if (REPLY_MODE === "twiml") outbox.push(text);
    else await whatsappService.sendText(inbound.from, text);
  };

  if (!inbound) return respond();
  if (REPLY_MODE !== "twiml") respond(); // rest mode: ack immediately

  try {
    // ── 1. Pending phone-verification code? ──
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

        await reply("✅ Your WhatsApp number is now verified for JobNix. You'll receive applicant messages here.");
        return;
      }
    }

    // ── 2. Normal business-question message ──
    const business = await businessProfilesRepo.findByPhone(`+${inbound.from}`);

    if (!business) {
      await reply(
        "This WhatsApp number isn't linked to a verified JobNix business account yet. " +
          "Please add and verify your phone number from your Business Dashboard settings."
      );
      return;
    }

    const { data: recentRows, error: recentErr } = await supabase
      .from("ai_conversations")
      .select("*")
      .eq("business_id", business.id)
      .eq("whatsapp_number", inbound.from)
      .order("created_at", { ascending: false })
      .limit(10);
    if (recentErr) throw recentErr;

    const history = recentRows
      .reverse()
      .map((m) => ({ role: m.role === "assistant" ? "model" : "user", parts: [{ text: m.text }] }));

    const answer = await geminiService.answerBusinessQuestion(business.id, inbound.text, history);

    await reply(answer);

    await supabase
      .from("ai_conversations")
      .insert({ business_id: business.id, whatsapp_number: inbound.from, role: "user", text: inbound.text });
    await supabase
      .from("ai_conversations")
      .insert({ business_id: business.id, whatsapp_number: inbound.from, role: "assistant", text: answer });
  } catch (err) {
    console.error("[whatsapp] failed to handle inbound message:", err);
    try {
      await reply("Sorry, something went wrong looking that up. Please try again shortly.");
    } catch (sendErr) {
      console.error("[whatsapp] fallback reply also failed:", sendErr);
    }
  } finally {
    respond(); // twiml mode: sends the queued replies back to Twilio now
  }
};

// Generates a code for the business to SEND to the JobNix WhatsApp number.
export const requestPhoneVerification = async (req, res) => {
  const { phone } = req.body; // E.164, e.g. +2348012345678
  if (!phone || !/^\+\d{8,15}$/.test(phone)) {
    return res.status(400).json({ success: false, message: "phone must be in E.164 format, e.g. +2348012345678" });
  }

  const code = String(crypto.randomInt(100000, 1000000));

  const { error } = await supabase
    .from("business_profiles")
    .update({ phone, phone_verified: false, phone_verification_code: code })
    .eq("id", req.businessId);
  if (error) return res.status(500).json({ success: false, message: error.message });

  res.json({
    success: true,
    code,
    sendToNumber: process.env.WHATSAPP_DISPLAY_NUMBER || "+14155238886",
    joinCode: process.env.TWILIO_SANDBOX_JOIN_CODE || null,
  });
};

// Status check: the frontend polls this after showing the code.
export const confirmPhoneVerification = async (req, res) => {
  const { data: business, error } = await supabase
    .from("business_profiles")
    .select("phone_verified, phone")
    .eq("id", req.businessId)
    .single();
  if (error) return res.status(500).json({ success: false, message: error.message });

  if (!business.phone_verified) {
    return res.status(400).json({ success: false, message: "Not verified yet. Send the code via WhatsApp first." });
  }

  res.json({ success: true, verified: true, phone: business.phone });
};