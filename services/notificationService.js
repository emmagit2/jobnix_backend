// lib/notificationService.js
import * as whatsappService from "./whatsappService.js";
import * as businessProfilesRepo from "../lib/businessProfilesRepo.js";
import * as notificationPrefsRepo from "../lib/notificationPreferencesRepo.js";

async function sendIfEnabled(businessId, prefKey, text) {
  const business = await businessProfilesRepo.findById(businessId);
  if (!business || !business.phone || !business.phone_verified) return;

  const prefs = await notificationPrefsRepo.get(businessId);
  if (!prefs[prefKey]) return;

  // Phone numbers are stored as +234..., the WhatsApp Cloud API wants no leading '+'
  const to = business.phone.replace(/^\+/, "");
  await whatsappService.sendText(to, text);
}

export async function notifyNewApplicant(businessId, jobTitle, applicantName) {
  await sendIfEnabled(
    businessId,
    "new_applicant",
    `📩 New applicant! ${applicantName} just applied to "${jobTitle}".`
  );
}

export async function notifyJobExpiringSoon(businessId, jobTitle, expiresAt) {
  const date = new Date(expiresAt).toDateString();
  await sendIfEnabled(
    businessId,
    "job_expiring_soon",
    `⏰ Heads up — your job "${jobTitle}" expires on ${date}. Renew it to keep receiving applicants.`
  );
}

export async function notifyNewMessage(businessId, applicantName, jobTitle) {
  await sendIfEnabled(
    businessId,
    "messages",
    `💬 New message from ${applicantName} about "${jobTitle}". Reply from your JobNix dashboard.`
  );
}

export async function notifyWeeklySummary(businessId, summaryText) {
  await sendIfEnabled(businessId, "weekly_summary", `📊 Your JobNix weekly summary:\n\n${summaryText}`);
}