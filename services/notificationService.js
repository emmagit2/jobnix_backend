// services/notificationService.js
import { supabase } from "../config/supabase.js";
import webpush from "web-push";

// Set these three env vars. Generate the key pair once with:
//   npx web-push generate-vapid-keys
webpush.setVapidDetails(
  process.env.VAPID_SUBJECT || "mailto:support@jobnix.ng",
  process.env.VAPID_PUBLIC_KEY,
  process.env.VAPID_PRIVATE_KEY
);

// Maps a notification "type" to the notification_preferences column that
// gates it. weekly_summary intentionally has no gate check here — the cron
// job already only queries phone_verified businesses for it.
const PREFERENCE_COLUMN = {
  new_applicant: "new_applicant",
  application_status_change: "application_status_change",
  job_expiring_soon: "job_expiring_soon",
  payment_success: "payment_success",
  referral_commission: "referral_commission",
  message: "messages",
  weekly_summary: "weekly_summary",
};

async function isEnabled(businessId, type) {
  const column = PREFERENCE_COLUMN[type];
  if (!column) return true; // unknown type — don't silently block it

  const { data, error } = await supabase
    .from("notification_preferences")
    .select(column)
    .eq("business_id", businessId)
    .single();

  // No preferences row yet, or a read error — default to sending rather
  // than silently dropping a notification because of a missing row.
  if (error || !data) return true;
  return data[column] !== false;
}

async function sendPush(businessId, { title, body, link }) {
  const { data: subs, error } = await supabase
    .from("push_subscriptions")
    .select("id, endpoint, p256dh, auth")
    .eq("business_id", businessId);
  if (error || !subs?.length) return;

  const payload = JSON.stringify({ title, body, link });

  await Promise.all(
    subs.map(async (sub) => {
      try {
        await webpush.sendNotification(
          { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
          payload
        );
      } catch (err) {
        // 410 Gone / 404 = the browser unsubscribed or the subscription
        // expired — clean it up so we stop wasting sends on it.
        if (err.statusCode === 410 || err.statusCode === 404) {
          await supabase.from("push_subscriptions").delete().eq("id", sub.id);
        } else {
          console.error("sendPush error for subscription", sub.id, err.message);
        }
      }
    })
  );
}

// Core entry point. Writes the in-app feed row (respecting preferences)
// and fires a push in parallel. Every specific notify* helper below
// funnels through this.
async function notify(businessId, type, { title, body, link, metadata } = {}) {
  const enabled = await isEnabled(businessId, type);
  if (!enabled) return;

  const { error: insertErr } = await supabase.from("notifications").insert({
    business_id: businessId,
    type,
    title,
    body,
    link: link || null,
    metadata: metadata || null,
  });
  if (insertErr) console.error("notify() insert error:", insertErr.message);

  await sendPush(businessId, { title, body, link });
}

// =============================
// Specific notification helpers — call these from your controllers
// =============================

export async function notifyNewApplicant(businessId, jobTitle, applicantName) {
  await notify(businessId, "new_applicant", {
    title: "New applicant",
    body: `${applicantName} applied for "${jobTitle}"`,
    link: "/dashboard/applicants",
  });
}

export async function notifyApplicationStatusChange(businessId, applicantName, jobTitle, status) {
  await notify(businessId, "application_status_change", {
    title: "Application updated",
    body: `${applicantName}'s application for "${jobTitle}" is now ${status}`,
    link: "/dashboard/applicants",
  });
}

// Kept as the same name/signature cronController.js already calls.
export async function notifyJobExpiringSoon(businessId, jobTitle, deadline) {
  await notify(businessId, "job_expiring_soon", {
    title: "Job posting expiring soon",
    body: `"${jobTitle}" closes on ${new Date(deadline).toLocaleDateString()}`,
    link: "/dashboard/jobs",
  });
}

export async function notifyPaymentSuccess(businessId, jobTitle, amount, currency = "NGN") {
  await notify(businessId, "payment_success", {
    title: "Payment successful",
    body: `Payment of ${currency} ${Number(amount).toLocaleString()} for "${jobTitle}" was received`,
    link: "/dashboard/jobs",
  });
}

export async function notifyReferralCommissionEarned(businessId, referredBusinessName, amount, currency = "NGN") {
  await notify(businessId, "referral_commission", {
    title: "Referral commission earned",
    body: `You earned ${currency} ${Number(amount).toLocaleString()} from ${referredBusinessName}'s job posting`,
    link: "/dashboard/referrals",
  });
}

export async function notifyNewMessage(businessId, senderName, preview) {
  await notify(businessId, "message", {
    title: `New message from ${senderName}`,
    body: preview,
    link: "/dashboard/messages",
  });
}

// Kept as the same name/signature cronController.js already calls.
export async function notifyWeeklySummary(businessId, summaryText) {
  await notify(businessId, "weekly_summary", {
    title: "Your weekly summary",
    body: summaryText,
    link: "/dashboard",
  });
}