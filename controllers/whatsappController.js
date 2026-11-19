// controllers/whatsappController.js  (Twilio version, sandbox-safe replies)
import crypto from "crypto";
import twilio from "twilio";
import { supabase } from "../config/supabase.js";
import * as whatsappService from "../services/whatsappService.js";
import * as geminiService from "../services/geminiService.js";
import * as postJobFlow from "../services/postJobFlowService.js";
import { getLoginNudge } from "../services/loginNudgeService.js";
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

    // ── 2. Normal business message ──
    const business = await businessProfilesRepo.findByPhone(`+${inbound.from}`);

    if (!business) {
      await reply(
        "Hi! To post a job or check your jobs on JobNix, you first need a business account.\n\n" +
          "1. Sign up at https://jobnix.ng (choose Business)\n" +
          "2. In Business Profile settings, add and verify this WhatsApp number\n" +
          '3. Come back here and send "Post a job"'
      );
      return;
    }

    // ── 2a. Job posting in progress? Handle it before anything else ──
    const postSession = await postJobFlow.getActiveSession(business.id);
    if (postSession) {
      const flowReply = await postJobFlow.handlePostJobMessage(
        business,
        postSession,
        inbound.text,
        inbound.from // digits only, e.g. 2348012345678
      );
      await reply(flowReply);
      return;
    }

    // ── 2b. Greeting ──
    const greeting = /^(hi|hello|hey|hell0|good (morning|afternoon|evening)|menu|help)\b/i;
    if (greeting.test(inbound.text.trim())) {
      await reply(
        `👋 Hi ${business.business_name || "there"}! I'm the JobNix assistant.\n\n` +
          "Ask me things like:\n" +
          "• Post a job\n" +
          "• List my jobs\n" +
          "• How many views did my Marketing Intern job get?\n" +
          "• How many applications do I have?"
      );
      const greetNudge = await getLoginNudge(business);
      if (greetNudge) await reply(greetNudge);
      return;
    }

    // ── 2c. Question for Gemini ──
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

    // Inactive owner? Add a login reminder, but not if they just started posting a job here
    const startedPosting = await postJobFlow.getActiveSession(business.id);
    const nudge = startedPosting ? null : await getLoginNudge(business);

    await reply(nudge ? `${answer}\n\n${nudge}` : answer);

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