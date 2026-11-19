// services/postJobFlowService.js
//
// Posts an informal job entirely inside WhatsApp: asks the form questions one by one,
// saves the job (status "pending", payment "pending") exactly like the website's
// submitInformalJob, and sends a Paystack payment link.
// Gemini only STARTS the flow (startJobPosting). Everything after that is fixed
// code, so the model can never skip a question or change a price.
import crypto from "crypto";
import { supabase } from "../config/supabase.js";
import * as paymentsRepo from "../lib/paymentsRepo.js";
import { initializeTransaction } from "./paystackService.js";

const SESSION_TTL_MS = 24 * 60 * 60 * 1000;

const CATEGORIES = ["Barbing Salon","Hair Salon","Makeup & Beauty","Restaurant & Cooking","Bakery","Fashion & Tailoring","Mechanic","Electrician","Plumber","Welder","Driver","Delivery & Dispatch","Cleaning","Security","Shop Attendant","Construction","Laundry","Hotel & Hospitality","Other"];
const PAY_TYPES = ["Daily","Weekly","Monthly","Per job"];
const STATES = ["Abia","Adamawa","Akwa Ibom","Anambra","Bauchi","Bayelsa","Benue","Borno","Cross River","Delta","Ebonyi","Edo","Ekiti","Enugu","FCT (Abuja)","Gombe","Imo","Jigawa","Kaduna","Kano","Katsina","Kebbi","Kogi","Kwara","Lagos","Nasarawa","Niger","Ogun","Ondo","Osun","Oyo","Plateau","Rivers","Sokoto","Taraba","Yobe","Zamfara"];

// `code` is what jobs.plan accepts (jobs_plan_check): '3w' | '1m' | '2m'
export const PLANS = {
  1: { code: "3w", label: "3 weeks", days: 21, price: 1500 },
  2: { code: "1m", label: "1 month", days: 30, price: 2500 },
  3: { code: "2m", label: "2 months", days: 60, price: 3500 },
};
export const EXTRA_WORKER_PRICE = 500;
export const calcTotal = (planKey, workers) =>
  PLANS[planKey].price + (Math.min(Math.max(workers, 1), 10) - 1) * EXTRA_WORKER_PRICE;

const naira = (n) => "₦" + Number(n).toLocaleString("en-NG");
const numbered = (arr) => arr.map((x, i) => `${i + 1}. ${x}`).join("\n");
const pick = (arr, text) => {
  const n = parseInt(text, 10);
  if (n >= 1 && n <= arr.length) return arr[n - 1];
  return arr.find((x) => x.toLowerCase() === text.trim().toLowerCase()) || null;
};

// Same slug logic as the website (informalJobs.controller.js)
function generateSlug(title, location, shortId) {
  const base = [title, location].filter(Boolean).join(" ")
    .toLowerCase().replace(/[^a-z0-9\s-]/g, "").replace(/\s+/g, "-")
    .replace(/-+/g, "-").replace(/^-|-$/g, "").slice(0, 74);
  return `${base}-${shortId}`;
}

// Each step: ask(draft) = the question, parse(text) = { value } or { error }
const STEPS = {
  category: {
    ask: () => `What are you hiring for? Reply with a number:\n${numbered(CATEGORIES)}`,
    parse: (t) => {
      const v = pick(CATEGORIES, t);
      return v ? { value: v } : { error: "Please reply with a number from the list." };
    },
  },
  title: {
    ask: () => "What is the job title? (e.g. Barber)",
    parse: (t) => (t.trim().length >= 2 ? { value: t.trim().slice(0, 120) } : { error: "Please type the job title." }),
  },
  address: {
    ask: () => "What is the workplace address? (Reply SKIP to leave it out)",
    parse: (t) => ({ value: /^skip$/i.test(t.trim()) ? "" : t.trim().slice(0, 200) }),
  },
  description: {
    ask: () => "Describe the job in a few lines: what the worker will do and what you expect.",
    parse: (t) =>
      t.trim().length >= 10
        ? { value: t.trim().slice(0, 2000) }
        : { error: "Please add a bit more detail (at least a short sentence)." },
  },
  pay_type: {
    ask: () => `How do you pay?\n${numbered(PAY_TYPES)}`,
    parse: (t) => {
      const v = pick(PAY_TYPES, t);
      return v ? { value: v } : { error: "Reply 1, 2, 3 or 4." };
    },
  },
  pay_amount: {
    ask: () => "How much do you pay, in naira? (e.g. 5000)",
    parse: (t) => {
      const m = t.toLowerCase().replace(/[,₦\s]|naira/g, "").match(/^(\d+(?:\.\d+)?)(k)?$/);
      if (!m) return { error: "Please send just the amount, e.g. 5000 or 5k." };
      const n = Math.round(parseFloat(m[1]) * (m[2] ? 1000 : 1));
      return n > 0 ? { value: String(n) } : { error: "Amount must be more than 0." };
    },
  },
  state: {
    ask: () => "Which state do you want to hire from? Type the state name (e.g. Lagos).",
    parse: (t) => {
      const q = t.trim().toLowerCase();
      const hit =
        STATES.find((s) => s.toLowerCase() === q) ||
        (/^(fct|abuja)$/.test(q) ? "FCT (Abuja)" : null) ||
        (q.length >= 3 ? STATES.find((s) => s.toLowerCase().startsWith(q)) : null);
      return hit ? { value: hit } : { error: "I couldn't match that state. Please type it again." };
    },
  },
  areas: {
    ask: (d) => `Which areas in ${d.state}? Type them separated by commas (e.g. Yaba, Surulere), or reply ALL.`,
    parse: (t) => ({ value: /^all$/i.test(t.trim()) ? "All areas" : t.trim().slice(0, 300) }),
  },
  plan: {
    ask: () =>
      "How long should the job stay live? (the time starts when we approve it)\n" +
      Object.entries(PLANS).map(([k, p]) => `${k}. ${p.label} - ${naira(p.price)}`).join("\n"),
    parse: (t) => (PLANS[parseInt(t, 10)] ? { value: parseInt(t, 10) } : { error: "Reply 1, 2 or 3." }),
  },
  workers: {
    ask: () =>
      `How many workers do you need? (1 to 10. 1 is included, each extra worker adds ${naira(EXTRA_WORKER_PRICE)})`,
    parse: (t) => {
      const n = parseInt(t, 10);
      return n >= 1 && n <= 10 ? { value: n } : { error: "Please send a number from 1 to 10." };
    },
  },
};
const ORDER = ["category", "title", "address", "description", "pay_type", "pay_amount", "state", "areas", "plan", "workers"];

function summary(d) {
  return [
    "Please check your job:",
    `• ${d.title} (${d.category})`,
    d.address ? `• Address: ${d.address}` : null,
    `• Pay: ${naira(d.pay_amount)} ${d.pay_type.toLowerCase()}`,
    `• Hiring from: ${d.areas}, ${d.state}`,
    `• Live for ${PLANS[d.plan].label}, ${d.workers} worker${d.workers > 1 ? "s" : ""}`,
    `• Total to pay: ${naira(calcTotal(d.plan, d.workers))}`,
    "",
    "Reply YES to get your payment link, EDIT to start again, or CANCEL.",
  ].filter(Boolean).join("\n");
}

// ── Session helpers ────────────────────────────────────────────────────────
const saveSession = (businessId, step, draft) =>
  supabase.from("whatsapp_post_sessions").upsert({
    business_id: businessId,
    step,
    draft,
    updated_at: new Date().toISOString(),
  });

const clearSession = (businessId) =>
  supabase.from("whatsapp_post_sessions").delete().eq("business_id", businessId);

export async function getActiveSession(businessId) {
  const { data } = await supabase
    .from("whatsapp_post_sessions")
    .select("*")
    .eq("business_id", businessId)
    .maybeSingle();
  if (!data) return null;
  if (Date.now() - new Date(data.updated_at).getTime() > SESSION_TTL_MS) {
    await clearSession(businessId);
    return null;
  }
  return data;
}

/** Called by the Gemini tool when the owner wants to post a job. */
export async function startJobPosting(businessId) {
  await saveSession(businessId, "category", {});
  return {
    started: true,
    firstMessage:
      "Let's post your job. I'll ask a few quick questions. Reply CANCEL any time.\n\n" + STEPS.category.ask({}),
  };
}

// ── Job + payment ──────────────────────────────────────────────────────────
async function getBusinessEmail(businessId) {
  // Same lookup your paymentController uses
  const { data, error } = await supabase.from("profiles").select("email").eq("id", businessId).single();
  if (error) throw error;
  return data.email;
}

async function createJobAndPaymentLink(business, whatsappNumber, d) {
  const amount = calcTotal(d.plan, d.workers);
  const plan = PLANS[d.plan];

  // Same shape the website stores: "All Lagos" for the whole state, never an empty list.
  const seen = new Set();
  let areaList =
    d.areas === "All areas"
      ? []
      : d.areas
          .split(",")
          .map((s) => s.trim().replace(/\s+/g, " ").slice(0, 60))
          .filter((s) => s && !seen.has(s.toLowerCase()) && seen.add(s.toLowerCase()))
          .slice(0, 30);
  if (areaList.length === 0) areaList = [`All ${d.state}`];

  const shortId = Math.random().toString(36).slice(2, 8);

  console.log("[wa] inserting job");
  const { data: job, error } = await supabase
    .from("jobs")
    .insert({
      title: d.title,
      location: d.address || null,
      role_category: d.category,
      work_type: "informal",
      job_type: "Full-time",
      description: d.description,
      requirements: [],
      responsibilities: [],
      benefits: [],

      pay_type: d.pay_type,
      pay_amount: d.pay_amount,

      candidate_state: d.state,
      candidate_locations: areaList,

      plan: plan.code,
      duration_days: plan.days,
      workers_needed: d.workers,

      apply_method: "platform",
      apply_link: null,
      apply_email: null,
      how_to_apply: null,
      recruiter_email: null,
      slug: generateSlug(d.title, d.address, shortId),

      // Same as the website: pending review. Admin approval is blocked until payment_status is "paid".
      status: "pending",
      submitted_by_business_id: business.id,

      posted_by_type: "owner",
      agent_name: null,
      agent_phone: null,
      agent_liability_accepted: false,
      agent_liability_accepted_at: null,

      payment_status: "pending",
      payment_amount: amount,
      payment_currency: "NGN",
    })
    .select("id")
    .single();
  console.log("[wa] job inserted", job?.id, error?.message);
  if (error) throw error;

  try {
    // Same pattern as initializeInformalJobPayment in paymentController, so your existing
    // webhook/callback (finalizePaymentIfSuccessful) marks this job paid with no changes.
    const reference = `jobnix_informal_${job.id}_${crypto.randomBytes(6).toString("hex")}`;
    const amountKobo = amount * 100;

    await paymentsRepo.create({
      businessId: business.id,
      jobId: job.id,
      reference,
      amountKobo,
      purpose: "informal_job",
    });
    console.log("[wa] payment record created");

    const email = await getBusinessEmail(business.id);
    console.log("[wa] calling paystack");
    const tx = await initializeTransaction({
      email,
      amountKobo,
      reference,
      metadata: { jobId: job.id, businessId: business.id, purpose: "informal_job", whatsapp: whatsappNumber },
    });

    console.log("[wa] paystack ok");
    await supabase.from("jobs").update({ payment_reference: reference }).eq("id", job.id);
    return { url: tx.authorization_url, amount };
  } catch (e) {
    console.error("[wa] failed:", e.message);
    // Don't leave an unpaid duplicate behind when the owner replies YES again.
    await supabase.from("jobs").delete().eq("id", job.id);
    throw e;
  }
}

/**
 * Called by the controller while a session is active. Returns the text to send back.
 * @param {object} business   row from business_profiles (needs .id)
 * @param {object} session    row from whatsapp_post_sessions
 * @param {string} text       the owner's message
 * @param {string} whatsappNumber digits only, e.g. "2348012345678"
 */
export async function handlePostJobMessage(business, session, text, whatsappNumber) {
  const businessId = business.id;
  const t = String(text || "").trim();

  if (/^cancel$/i.test(t)) {
    await clearSession(businessId);
    return 'Cancelled. Send "post a job" whenever you\'re ready.';
  }

  if (session.step === "confirm") {
    if (/^edit$/i.test(t)) {
      await saveSession(businessId, "category", {});
      return "Okay, let's start again.\n\n" + STEPS.category.ask({});
    }
    if (!/^(yes|y)$/i.test(t)) return "Reply YES to get your payment link, EDIT to start again, or CANCEL.";

    try {
      const { url, amount } = await createJobAndPaymentLink(business, whatsappNumber, session.draft);
      await clearSession(businessId);
      return (
        `Pay ${naira(amount)} here to submit your job for review:\n${url}\n\n` +
        `After payment we review the job, and its ${PLANS[session.draft.plan].label} starts when it is approved.`
      );
    } catch (err) {
      console.error("[postJobFlow] create job/payment failed:", err.message);
      return "Sorry, I couldn't create your payment link. Please reply YES to try again.";
    }
  }

  const step = STEPS[session.step];
  if (!step) {
    await clearSession(businessId);
    return 'Something went wrong. Send "post a job" to start again.';
  }

  const result = step.parse(t);
  if (result.error) return result.error + "\n\n" + step.ask(session.draft);

  const draft = { ...session.draft, [session.step]: result.value };
  const next = ORDER[ORDER.indexOf(session.step) + 1];
  if (!next) {
    await saveSession(businessId, "confirm", draft);
    return summary(draft);
  }
  await saveSession(businessId, next, draft);
  return STEPS[next].ask(draft);
}