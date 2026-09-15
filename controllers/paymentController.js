import crypto from "crypto";
import { supabase } from "../config/supabase.js";
import * as paymentsRepo from "../lib/paymentsRepo.js";
import * as jobsRepo from "../lib/jobsRepo.js";
import * as businessProfilesRepo from "../lib/businessProfilesRepo.js";
import * as paystackService from "../services/paystackService.js";
import { PLANS, PREMIUM_SUBSCRIPTION_FEE_KOBO } from "../config/plans.js";

// business_profiles has no email column of its own — it's a 1:1 extension
// of profiles (business_profiles.id references profiles.id), and email
// lives only on profiles. Same lookup jobsController.js already does in
// getMyJobs/getJobStats/getJobApplicants — reused here so callers never
// have to know or supply the email themselves.
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

  const updated = await paymentsRepo.markSuccess(reference, tx);

  if (updated.purpose === "premium_subscription") {
    await businessProfilesRepo.setPlan(updated.business_id, "premium");
  } else if (updated.purpose === "informal_job") {
    await jobsRepo.markInformalJobPaid(updated.job_id, reference);
  }
  return updated;
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