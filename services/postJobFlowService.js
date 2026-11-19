// services/postJobFlowService.js
//
// Posts an informal job entirely inside WhatsApp: asks the form questions one by one,
// saves the job (status "pending", payment "pending") exactly like the website's
// submitInformalJob, and sends a Paystack payment link.
// The owner can describe the whole job in ONE message. Gemini only EXTRACTS fields from
// it (jobDraftExtractor.js); every value is re-checked here with the same rules as the
// step-by-step questions, and the price is always calculated in code. The bot then asks
// only for what is missing. If Gemini fails, it falls back to one question at a time.
import crypto from "crypto";
import { supabase } from "../config/supabase.js";
import * as paymentsRepo from "../lib/paymentsRepo.js";
import { initializeTransaction } from "./paystackService.js";
import { extractJobFields } from "./jobDraftExtractor.js";

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

// ── One-message posting ────────────────────────────────────────────────────
// Fields the owner must give. address (optional), description (written for them) and
// workers (1 is included) get defaults. Same relative order as ORDER.
const SMART_REQUIRED = ["category", "title", "pay_type", "pay_amount", "state", "areas", "plan"];

let extractor = extractJobFields;
/** Test hook: swap the Gemini extractor for a fake. Call with no argument to restore. */
export function _setExtractorForTests(fn) {
  extractor = fn || extractJobFields;
}

const publicDraft = (d) => Object.fromEntries(Object.entries(d || {}).filter(([k]) => !k.startsWith("_")));
const num = (v) => (typeof v === "number" || (typeof v === "string" && v.trim() !== "") ? Number(v) : NaN);
const isStr = (v) => typeof v === "string" && v.trim() !== "";

/** Keeps only the values that pass the same rules as the step-by-step questions. */
function cleanFields(raw) {
  const r = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  const out = {};

  if (isStr(r.category)) {
    const hit = CATEGORIES.find((c) => c.toLowerCase() === r.category.trim().toLowerCase());
    if (hit) out.category = hit;
  }
  if (isStr(r.title)) {
    const p = STEPS.title.parse(r.title);
    if (p.value) out.title = p.value;
  }
  if (isStr(r.address)) out.address = r.address.trim().slice(0, 200);
  if (isStr(r.description)) {
    const p = STEPS.description.parse(r.description);
    if (p.value) out.description = p.value;
  }
  if (isStr(r.pay_type)) {
    const hit = PAY_TYPES.find((x) => x.toLowerCase() === r.pay_type.trim().toLowerCase());
    if (hit) out.pay_type = hit;
  }
  if (typeof r.pay_amount === "number" || isStr(r.pay_amount)) {
    const p = STEPS.pay_amount.parse(String(r.pay_amount));
    if (p.value) out.pay_amount = p.value;
  }
  if (isStr(r.state)) {
    const p = STEPS.state.parse(r.state);
    if (p.value) out.state = p.value;
  }
  if (Array.isArray(r.areas)) {
    const names = r.areas.filter(isStr).map((x) => x.trim());
    if (names.length) out.areas = names.join(", ").slice(0, 300);
  } else if (isStr(r.areas)) {
    out.areas = /^all( areas)?$/i.test(r.areas.trim()) ? "All areas" : r.areas.trim().slice(0, 300);
  }
  const plan = num(r.plan);
  if (Number.isInteger(plan) && PLANS[plan]) out.plan = plan;
  const workers = num(r.workers);
  if (Number.isInteger(workers) && workers >= 1 && workers <= 10) out.workers = workers;

  return out;
}

/** Ask Gemini to read the text, then keep only what is valid. {} if nothing usable. */
async function smartExtract(text, current = null) {
  let raw = {};
  try {
    raw = await extractor(text, {
      categories: CATEGORIES,
      payTypes: PAY_TYPES,
      states: STATES,
      current: current ? publicDraft(current) : null,
    });
  } catch (err) {
    console.error("[postJobFlow] extractor failed:", err.message);
  }
  return cleanFields(raw);
}

const defaultDescription = (d) =>
  `Hiring: ${d.title} (${d.category || "general"}). Reliable and hardworking applicants are welcome to apply.`;

function applyDefaults(d) {
  const out = { ...d };
  if (out.workers === undefined) out.workers = 1;
  if (out.address === undefined) out.address = "";
  if (out.description === undefined && out.title) {
    out.description = defaultDescription(out);
    out._autoDesc = true; // so a later title change can refresh it
  }
  return out;
}

const MISSING_LINES = {
  category: () => "the type of business (e.g. Barbing Salon, Driver, Cleaning)",
  title: () => "the job title (e.g. Barber)",
  state: () => "the state you want to hire from (e.g. Lagos)",
  areas: (d) => (d.state ? `the areas in ${d.state}, or ALL (e.g. Yaba, Surulere)` : "the areas to hire from, or ALL"),
  plan: () =>
    "how long the job stays live: " +
    (() => {
      const opts = Object.values(PLANS).map((p) => `${p.label} (${naira(p.price)})`);
      return opts.slice(0, -1).join(", ") + " or " + opts[opts.length - 1];
    })(),
};

function askMissing(d, missing) {
  const lines = [];
  const noType = missing.includes("pay_type");
  const noAmount = missing.includes("pay_amount");
  for (const k of missing) {
    if (k === "pay_type" || k === "pay_amount") {
      if (k === "pay_amount" && noType) continue; // covered by the combined pay line
      lines.push(
        noType && noAmount
          ? "how much you pay and how often (e.g. ₦5k daily)"
          : noType
            ? "how often you pay: daily, weekly, monthly or per job"
            : "how much you pay, in naira (e.g. 5000)"
      );
    } else {
      lines.push(MISSING_LINES[k](d));
    }
  }
  if (lines.length === 1) return `Almost there. Please tell me ${lines[0]}.\n\nReply CANCEL to stop.`;
  return `Almost there. Please tell me:\n${lines.map((l) => `• ${l}`).join("\n")}\n\nYou can send it all in one message. Reply CANCEL to stop.`;
}

/** Fills defaults, then either shows the summary or asks for what is still missing. */
async function moveOn(businessId, rawDraft) {
  const draft = applyDefaults(rawDraft);
  const missing = SMART_REQUIRED.filter((k) => draft[k] === undefined);
  if (missing.length === 0) {
    await saveSession(businessId, "confirm", draft);
    return summary(draft);
  }
  await saveSession(businessId, "fill", draft);
  return askMissing(draft, missing);
}

/** Falls back to the classic one-question-at-a-time flow for whatever is still missing. */
async function stepByStep(businessId, rawDraft, lead = "") {
  const draft = applyDefaults(rawDraft);
  const first = SMART_REQUIRED.find((k) => draft[k] === undefined);
  if (!first) return await moveOn(businessId, draft);
  await saveSession(businessId, first, draft);
  return lead + STEPS[first].ask(draft);
}

/** Merges newly read fields into a draft, dropping anything the change makes stale. */
function mergeFields(draft, found) {
  const merged = { ...draft, ...found };
  // New state: the old areas belong to the old state, so ask again.
  if (found.state && found.state !== draft.state && found.areas === undefined) delete merged.areas;
  // Own description wins; an auto-written one is refreshed when the job itself changes.
  if (found.description !== undefined) merged._autoDesc = false;
  else if (draft._autoDesc && (found.title || found.category)) delete merged.description;
  return merged;
}

function summary(d) {
  const about = d.description ? d.description.replace(/\s+/g, " ").slice(0, 160) : null;
  return [
    "Please check your job:",
    `• ${d.title} (${d.category})`,
    d.address ? `• Address: ${d.address}` : null,
    about ? `• About: ${about}${d.description.length > 160 ? "…" : ""}` : null,
    `• Pay: ${naira(d.pay_amount)} ${d.pay_type.toLowerCase()}`,
    `• Hiring from: ${d.areas}, ${d.state}`,
    `• Live for ${PLANS[d.plan].label}, ${d.workers} worker${d.workers > 1 ? "s" : ""}`,
    `• Total to pay: ${naira(calcTotal(d.plan, d.workers))}`,
    "",
    'Reply YES to get your payment link. To change something, just tell me (e.g. "make it ₦6k" or "3 workers"). ' +
      "EDIT starts again, CANCEL stops.",
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

/**
 * Called by the Gemini tool when the owner wants to post a job.
 * userMessage is the owner's ORIGINAL message, so "I need 2 barbers in Yaba, 5k daily"
 * can fill most of the job in one go.
 */
export async function startJobPosting(businessId, userMessage = "") {
  const header = "Let's post your job. Reply CANCEL any time.\n\n";
  const text = String(userMessage || "").trim();

  const found = text.length > 12 ? await smartExtract(text) : {};
  if (Object.keys(found).length === 0) {
    await saveSession(businessId, "intro", {});
    return {
      started: true,
      firstMessage:
        header +
        "Tell me about the job in one message: who you need, where, how much you pay and for how long.\n" +
        'Example: "I need 2 barbers in Yaba, Lagos, ₦5k daily, for 1 month"\n\n' +
        "Or reply STEPS and I'll ask one question at a time.",
    };
  }
  return { started: true, firstMessage: header + (await moveOn(businessId, found)) };
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
    if (!/^(yes|y)$/i.test(t)) {
      // Anything else is treated as a change request ("make it 6k", "3 workers").
      const found = await smartExtract(t, session.draft);
      if (Object.keys(found).length === 0) {
        return (
          "I didn't catch a change. Reply YES to get your payment link, tell me what to change " +
          '(e.g. "make it ₦6k"), EDIT to start again, or CANCEL.'
        );
      }
      return await moveOn(businessId, mergeFields(session.draft, found));
    }

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

  if (session.step === "intro") {
    if (/^steps$/i.test(t)) {
      await saveSession(businessId, "category", {});
      return STEPS.category.ask({});
    }
    const found = await smartExtract(t);
    if (Object.keys(found).length === 0) {
      await saveSession(businessId, "category", {});
      return "I couldn't read that, so let's go one question at a time.\n\n" + STEPS.category.ask({});
    }
    return await moveOn(businessId, found);
  }

  if (session.step === "fill") {
    if (/^steps$/i.test(t)) return await stepByStep(businessId, session.draft);
    const found = await smartExtract(t, session.draft);
    if (Object.keys(found).length === 0) {
      return await stepByStep(businessId, session.draft, "I couldn't read that, so let's go one question at a time.\n\n");
    }
    return await moveOn(businessId, mergeFields(session.draft, found));
  }

  const step = STEPS[session.step];
  if (!step) {
    await clearSession(businessId);
    return 'Something went wrong. Send "post a job" to start again.';
  }

  const result = step.parse(t);
  if (result.error) return result.error + "\n\n" + step.ask(session.draft);

  const draft = { ...session.draft, [session.step]: result.value };
  const next = ORDER.slice(ORDER.indexOf(session.step) + 1).find((k) => draft[k] === undefined);
  if (!next) {
    await saveSession(businessId, "confirm", draft);
    return summary(draft);
  }
  await saveSession(businessId, next, draft);
  return STEPS[next].ask(draft);
}