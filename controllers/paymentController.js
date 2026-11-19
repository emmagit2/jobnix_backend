import crypto from "crypto";
import { supabase } from "../config/supabase.js";
import * as paymentsRepo from "../lib/paymentsRepo.js";
import * as jobsRepo from "../lib/jobsRepo.js";
import * as businessProfilesRepo from "../lib/businessProfilesRepo.js";
import * as paystackService from "../services/paystackService.js";
import { sendText } from "../services/whatsappService.js";
import { PLANS, PREMIUM_SUBSCRIPTION_FEE_KOBO } from "../config/plans.js";
 
const getBusinessEmail = async (businessId) => {
  const { data, error } = await supabase.from("profiles").select("email").eq("id", businessId).single();
  if (error) throw error;
  return data.email;
};

// Business dashboard calls this to pay the per-job posting fee (Free plan only —
// Premium businesses skip this since their plan includes unlimited posts).
//
// NOTE: your `jobs` table doesn't have a status/is_paid column, so this does
// NOT gate the job's visibility — it just records the payment. If you want
// unpaid jobs to be hidden until payment clears, add an `is_paid boolean`
// column to `jobs` and I'll wire the webhook below to flip it.
export async function initializeJobPayment(req, res) {
  const { jobId, email } = req.body;
  if (!jobId || !email) return res.status(400).json({ error: "jobId and email are required" });

  const job = await jobsRepo.findByIdForBusiness(jobId, req.businessId);
  if (!job) return res.status(404).json({ error: "Job not found" });

  const business = await businessProfilesRepo.findById(req.businessId);
  const plan = PLANS[business.plan] || PLANS.free;

  if (plan.jobPostingFeeKobo === 0) {
    return res.json({ freeActivation: true, message: "No charge needed under your Premium plan." });
  }

  const reference = `jobnix_job_${jobId}_${crypto.randomBytes(6).toString("hex")}`;

  await paymentsRepo.create({
    businessId: req.businessId,
    jobId,
    reference,
    amountKobo: plan.jobPostingFeeKobo,
    purpose: "job_posting",
  });

  const tx = await paystackService.initializeTransaction({
    email,
    amountKobo: plan.jobPostingFeeKobo,
    reference,
    metadata: { jobId, businessId: req.businessId, purpose: "job_posting" },
  });

  res.json({ authorizationUrl: tx.authorization_url, reference });
}

// Informal-job flat fee (₦1,500, stored per-job in jobs.payment_amount by
// submitInformalJob). Separate from initializeJobPayment above because this
// fee comes from the job row itself, not the business's plan — an informal
// job costs the same flat fee regardless of Free/Premium.
export async function initializeInformalJobPayment(req, res) {
  const { jobId } = req.body;
  if (!jobId) return res.status(400).json({ error: "jobId is required" });

  const job = await jobsRepo.findByIdForBusiness(jobId, req.businessId);
  if (!job) return res.status(404).json({ error: "Job not found" });
  if (job.payment_status === "paid") {
    return res.status(409).json({ error: "This job has already been paid for" });
  }

  const email = await getBusinessEmail(req.businessId);
  const amountKobo = Math.round(Number(job.payment_amount) * 100);
  const reference = `jobnix_informal_${jobId}_${crypto.randomBytes(6).toString("hex")}`;

  await paymentsRepo.create({
    businessId: req.businessId,
    jobId,
    reference,
    amountKobo,
    purpose: "informal_job",
  });

  const tx = await paystackService.initializeTransaction({
    email,
    amountKobo,
    reference,
    metadata: { jobId, businessId: req.businessId, purpose: "informal_job" },
  });

  res.json({ authorizationUrl: tx.authorization_url, reference });
}

// "Upgrade to Premium" button on the Account page
export async function initializePremiumUpgrade(req, res) {
  const { email } = req.body;
  if (!email) return res.status(400).json({ error: "email is required" });

  const reference = `jobnix_premium_${req.businessId}_${crypto.randomBytes(6).toString("hex")}`;

  await paymentsRepo.create({
    businessId: req.businessId,
    jobId: null,
    reference,
    amountKobo: PREMIUM_SUBSCRIPTION_FEE_KOBO,
    purpose: "premium_subscription",
  });

  const tx = await paystackService.initializeTransaction({
    email,
    amountKobo: PREMIUM_SUBSCRIPTION_FEE_KOBO,
    reference,
    metadata: { businessId: req.businessId, purpose: "premium_subscription" },
  });

  res.json({ authorizationUrl: tx.authorization_url, reference });
}

// Shared by both handleCallback and handleWebhook — verifies a transaction
// with Paystack and, if genuinely successful, marks the payment + does the
// purpose-specific follow-up (activate Premium / mark job paid). Safe to
// call from both places: markSuccess/markInformalJobPaid no-op if the
// payment was already processed, so there's no double-counting.
//
// Why both call it: the webhook is the real source of truth in production,
// but it's a server-to-server call — Paystack can't reach your machine on
// localhost. The callback IS reachable locally (it's just your browser
// being redirected), so during local dev this is what actually finalizes
// the payment. Once you deploy with a public webhook URL, both will fire
// and agree — no configuration change needed later.
 async function finalizePaymentIfSuccessful(reference) {
  const payment = await paymentsRepo.findByReference(reference);
  if (!payment || payment.status === "success") return payment;

  const tx = await paystackService.verifyTransaction(reference);
  if (tx.status !== "success") return payment;

  // What Paystack took must equal what we asked for.
  if (Number(tx.amount) !== Number(payment.amount_kobo)) {
    console.error(`Amount mismatch for ${reference}: paid ${tx.amount}, expected ${payment.amount_kobo}`);
    return payment;
  }

  // For informal jobs, it must also match the job's CURRENT price.
  if (payment.purpose === "informal_job") {
    const { data: job } = await supabase
      .from("jobs").select("payment_amount").eq("id", payment.job_id).single();
    if (Math.round(Number(job?.payment_amount) * 100) !== Number(payment.amount_kobo)) {
      console.error(`Price changed after init for ${reference}: needs manual review/refund`);
      return payment;
    }
  }

  const updated = await paymentsRepo.markSuccess(reference, tx);
  if (!updated) return payment; // another request already processed it

  if (updated.purpose === "premium_subscription") {
    await businessProfilesRepo.setPlan(updated.business_id, "premium");
  } else if (updated.purpose === "informal_job") {
    await jobsRepo.markInformalJobPaid(updated.job_id, reference);

    // Posted from WhatsApp? Tell the owner on WhatsApp too
    if (tx.metadata?.whatsapp) {
      sendText(String(tx.metadata.whatsapp), "Payment received. Your job is now being reviewed. We'll message you when it's live.")
        .catch((e) => console.error("WhatsApp payment confirmation failed:", e.message));
    }
  }
  return updated;
}

// Page shown after paying for a job that was posted from WhatsApp.
function whatsappReturnPage(success) {
  const number = String(process.env.TWILIO_WHATSAPP_FROM || "").replace(/\D/g, "");
  const link = number ? `https://wa.me/${number}` : "";
  const title = success ? "Payment received" : "Payment not completed";
  const text = success
    ? "Thank you. Your job is now being reviewed. We will message you on WhatsApp when it is live."
    : "Your payment did not go through. Go back to WhatsApp and send &quot;post a job&quot; to try again.";
  return `<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title>
<style>body{font-family:system-ui,sans-serif;background:#f6f7f9;margin:0;display:flex;min-height:100vh;align-items:center;justify-content:center}
.c{background:#fff;max-width:380px;margin:16px;padding:28px;border-radius:14px;text-align:center;box-shadow:0 2px 12px rgba(0,0,0,.08)}
h1{font-size:22px;margin:0 0 10px}p{color:#444;line-height:1.5}
a{display:inline-block;margin-top:14px;padding:12px 22px;background:#25d366;color:#fff;border-radius:10px;text-decoration:none;font-weight:600}</style></head>
<body><div class="c"><h1>${success ? "&#10003; " : ""}${title}</h1><p>${text}</p>
${link ? `<a href="${link}">Back to WhatsApp</a>` : ""}</div></body></html>`;
}

// Paystack redirects the browser here after checkout.
export async function handleCallback(req, res) {
  const { reference } = req.query;
  if (!reference) return res.status(400).send("Missing reference");

  const tx = await paystackService.verifyTransaction(reference);
  const success = tx.status === "success";

  if (success) {
    // See finalizePaymentIfSuccessful's comment — this is what actually
    // marks things paid locally, where the webhook can't reach you.
    await finalizePaymentIfSuccessful(reference).catch((err) => {
      console.error("finalizePaymentIfSuccessful (from callback) failed:", err);
    });
  }

  // Paid from WhatsApp? The owner is on their phone and may not be logged in,
  // so show a simple page that sends them back to the WhatsApp chat instead.
  if (tx.metadata?.whatsapp) {
    return res.status(200).type("html").send(whatsappReturnPage(success));
  }

  // Send informal-job payments back to the dashboard's Jobs tab (there's no
  // real /post-job route — this is a single-page tab-state app, so we pass
  // a `tab` query param instead and let BusinessDashboard read it on mount).
  // Everything else (job-posting fee, premium) goes to the dashboard too.
  const payment = await paymentsRepo.findByReference(reference);
  const tab = payment?.purpose === "informal_job" ? "jobs" : "overview";

  res.redirect(
    `${process.env.APP_BASE_URL}/business/dashboard?tab=${tab}&payment=${success ? "success" : "failed"}&ref=${reference}`
  );
}

// Lets the frontend poll for the webhook having landed, since the redirect
// in handleCallback above happens before the webhook is guaranteed to have
// arrived and processed. Usually resolves within a couple of seconds.
export async function getPaymentStatus(req, res) {
  const { reference } = req.query;
  if (!reference) return res.status(400).json({ error: "reference is required" });

  const payment = await paymentsRepo.findByReference(reference);
  if (!payment || payment.business_id !== req.businessId) {
    return res.status(404).json({ error: "Payment not found" });
  }

  res.json({ status: payment.status, purpose: payment.purpose, jobId: payment.job_id });
}

// Server-to-server webhook — the source of truth in production. On
// localhost this simply won't be reached (Paystack can't call your
// machine), and that's fine: handleCallback above covers local dev via the
// same shared finalizePaymentIfSuccessful function.
export async function handleWebhook(req, res) {
  const signature = req.headers["x-paystack-signature"];
  const valid = paystackService.verifyWebhookSignature(req.rawBody, signature);
  if (!valid) return res.sendStatus(401);

  res.sendStatus(200); // acknowledge immediately

  const event = req.body;
  if (event.event !== "charge.success") return;

  await finalizePaymentIfSuccessful(event.data.reference).catch((err) => {
    console.error("finalizePaymentIfSuccessful (from webhook) failed:", err);
  });
}