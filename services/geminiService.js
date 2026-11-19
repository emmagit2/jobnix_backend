// services/geminiService.js
//
// JobNix WhatsApp business assistant (Gemini function calling).
// Every number and name comes from your database via the tools below.
//
// Posting a job: Gemini only STARTS the flow with startJobPosting (the owner's original
// message is passed along). Reading the details, price and payment link are handled by
// services/postJobFlowService.js.
//
// Built against your real schema:
//   jobs.submitted_by_business_id  -> the owning business
//   jobs.status                    -> draft | pending | approved | rejected
//   jobs.deadline (formal)         -> expiry date for formal jobs
//   jobs.expires_at (informal)     -> expiry time for informal jobs
//   jobs.view_count / click_count / application_count
//
// STILL A GUESS: the applications table (not shared yet). See APPLICATIONS_TABLE.
// If it fails, the bot falls back to the application_count stored on each job.
import { GoogleGenAI } from "@google/genai";
import { supabase } from "../config/supabase.js";
import { startJobPosting } from "./postJobFlowService.js";

const apiKey = process.env.GEMINI_API_KEY;
if (!apiKey) console.warn("[geminiService] GEMINI_API_KEY is not set in .env");
const ai = new GoogleGenAI({ apiKey });
const MODEL = process.env.GEMINI_MODEL || "gemini-2.5-flash";

const APPLICATIONS_TABLE = "applications"; // expects: job_id, status, created_at, + a name column

// Dashboard links the bot can send when WhatsApp can't do the task.
// Defaults all open the business dashboard. If your dashboard opens a specific tab from
// the URL, set these in .env (e.g. DASH_PATH_APPLICANTS=/business/dashboard?tab=applicants).
const FRONTEND_URL = (process.env.FRONTEND_URL || "http://localhost:5173").replace(/\/+$/, "");
const DASHBOARD_PATHS = {
  overview: process.env.DASH_PATH_OVERVIEW || "/business/dashboard",
  post_job: process.env.DASH_PATH_POST_JOB || "/business/dashboard",
  jobs: process.env.DASH_PATH_JOBS || "/business/dashboard",
  applicants: process.env.DASH_PATH_APPLICANTS || "/business/dashboard",
  profile: process.env.DASH_PATH_PROFILE || "/business/dashboard",
};

// Only these business_profiles fields are ever shown to Gemini.
// (Never nin_number, phone, phone_verification_code, etc.)
const SAFE_PROFILE_FIELDS = [
  "business_name",
  "industry",
  "hiring_size",
  "business_type",
  "description",
  "address",
  "owner_name",
];

const JOB_COLUMNS =
  "id,title,location,job_type,status,rejection_reason,work_type,deadline,expires_at," +
  "created_date,view_count,click_count,application_count,workers_needed,is_urgent,payment_status";

const RETRYABLE_STATUSES = [503, 429];
const MAX_RETRIES = 2;
const BASE_DELAY_MS = 1000;
const MAX_TOOL_ROUNDS = 5;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ── Tool declarations ──────────────────────────────────────────────────────
const tools = [
  {
    functionDeclarations: [
      {
        name: "getBusinessOverview",
        description:
          "Full overview of this business: profile, whether it has posted jobs, how many jobs are " +
          "live, expired, pending approval, draft or rejected, and total views, clicks and applications. " +
          "Use for 'how am I doing', 'do I have any jobs', 'give me a summary'.",
        parameters: { type: "object", properties: {} },
      },
      {
        name: "listJobs",
        description:
          "List this business's jobs (newest first) with status, views, clicks and applications. " +
          "Optionally filter by status: live, expired, pending, draft or rejected.",
        parameters: {
          type: "object",
          properties: {
            filter: { type: "string", enum: ["all", "live", "expired", "pending", "draft", "rejected"] },
          },
        },
      },
      {
        name: "getJobStats",
        description:
          "Detailed stats for one job, matched by title (partial match allowed). " +
          "Also use to explain why a job is pending or rejected.",
        parameters: {
          type: "object",
          properties: { jobTitle: { type: "string", description: "Title or partial title of the job" } },
          required: ["jobTitle"],
        },
      },
      {
        name: "listApplicants",
        description:
          "List recent applicants. Pass jobTitle for one job, or omit it for all jobs.",
        parameters: {
          type: "object",
          properties: {
            jobTitle: { type: "string", description: "Optional title or partial title" },
            limit: { type: "integer", description: "How many to return (default 5, max 10)" },
          },
        },
      },
      {
        name: "startJobPosting",
        description:
          "Start posting a new job here in WhatsApp. Use when the owner wants to post, create or " +
          "advertise a job or hire someone. Takes no arguments. Do not ask them for details first: " +
          "their message is read automatically and only missing details are asked after this.",
        parameters: { type: "object", properties: {} },
      },
      {
        name: "getDashboardLink",
        description:
          "Get the link to the JobNix business dashboard. Use it when the owner wants something " +
          "WhatsApp cannot do (edit or delete a job, review or contact applicants, update the business " +
          "profile, see payments) or when they ask to post a job on the website or dashboard instead of WhatsApp.",
        parameters: {
          type: "object",
          properties: {
            section: {
              type: "string",
              enum: ["overview", "post_job", "jobs", "applicants", "profile"],
              description: "Which part of the dashboard they need",
            },
          },
        },
      },
      {
        name: "getApplicationsSummary",
        description:
          "Count applications received in a time period with a per-job breakdown. " +
          "Use for 'how many applied today / this week / this month'.",
        parameters: {
          type: "object",
          properties: { period: { type: "string", enum: ["today", "week", "month", "all"] } },
          required: ["period"],
        },
      },
    ],
  },
];

// ── Helpers ────────────────────────────────────────────────────────────────
function isExpired(job) {
  if (job.expires_at) return new Date(job.expires_at) < new Date(); // informal jobs
  if (job.deadline) return new Date(job.deadline) < new Date(new Date().toDateString()); // formal jobs
  return false;
}

// "live" = approved by admin and not past its expiry
const isLive = (job) => job.status === "approved" && !isExpired(job);

function jobState(job) {
  if (job.status !== "approved") return job.status; // draft | pending | rejected
  return isExpired(job) ? "expired" : "live";
}

function summarizeJob(job) {
  const out = {
    title: job.title,
    state: jobState(job),
    views: job.view_count,
    clicks: job.click_count,
    applications: job.application_count,
    workersNeeded: job.workers_needed,
  };
  if (job.is_urgent) out.urgent = true;
  const closes = job.expires_at || job.deadline;
  if (closes) out.closes = closes;
  if (job.status === "rejected" && job.rejection_reason) out.rejectionReason = job.rejection_reason;
  if (job.payment_status && job.payment_status !== "not_required") out.paymentStatus = job.payment_status;
  return out;
}

// Start of period in UTC. "today" uses Lagos time (UTC+1).
function periodStart(period) {
  if (period === "all") return null;
  const now = Date.now();
  if (period === "today") {
    const lagos = new Date(now + 3600000);
    return new Date(Date.UTC(lagos.getUTCFullYear(), lagos.getUTCMonth(), lagos.getUTCDate()) - 3600000);
  }
  return new Date(now - (period === "week" ? 7 : 30) * 86400000);
}

const applicantName = (a) => a.applicant_name || a.full_name || a.name || "Applicant";

async function fetchBusinessJobs(businessId) {
  const { data, error } = await supabase
    .from("jobs")
    .select(JOB_COLUMNS)
    .eq("submitted_by_business_id", businessId)
    .order("created_date", { ascending: false })
    .limit(200);
  if (error) throw error;
  return data || [];
}

async function findJobsByTitle(businessId, title) {
  const cleaned = String(title || "").replace(/[%_,]/g, " ").trim();
  if (!cleaned) return [];
  const { data, error } = await supabase
    .from("jobs")
    .select(JOB_COLUMNS)
    .eq("submitted_by_business_id", businessId)
    .ilike("title", `%${cleaned}%`)
    .order("created_date", { ascending: false })
    .limit(3);
  if (error) throw error;
  return data || [];
}

// ── Tool implementations ───────────────────────────────────────────────────
async function getBusinessOverview(businessId) {
  const { data: profileRow } = await supabase
    .from("business_profiles")
    .select("*")
    .eq("id", businessId)
    .single();

  const profile = {};
  for (const key of SAFE_PROFILE_FIELDS) {
    if (profileRow && profileRow[key] != null && profileRow[key] !== "") profile[key] = profileRow[key];
  }

  const jobs = await fetchBusinessJobs(businessId);
  const count = (fn) => jobs.filter(fn).length;
  const sum = (key) => jobs.reduce((n, j) => n + (j[key] || 0), 0);
  const submitted = count((j) => j.status !== "draft");

  return {
    profile,
    hasPostedJobs: submitted > 0,
    totalJobs: jobs.length,
    liveJobs: count(isLive),
    expiredJobs: count((j) => j.status === "approved" && isExpired(j)),
    pendingApproval: count((j) => j.status === "pending"),
    draftJobs: count((j) => j.status === "draft"),
    rejectedJobs: count((j) => j.status === "rejected"),
    totalViews: sum("view_count"),
    totalClicks: sum("click_count"),
    totalApplications: sum("application_count"),
    hasApplicants: sum("application_count") > 0,
  };
}

async function listJobs(businessId, { filter } = {}) {
  const jobs = await fetchBusinessJobs(businessId);
  if (jobs.length === 0) return { hasPostedJobs: false, jobs: [] };

  const f = filter || "all";
  const picked = jobs.filter((j) => f === "all" || jobState(j) === f);
  return {
    hasPostedJobs: true,
    filter: f,
    total: picked.length,
    jobs: picked.slice(0, 10).map(summarizeJob),
    moreNotShown: Math.max(picked.length - 10, 0),
  };
}

async function getJobStats(businessId, jobTitle) {
  const matches = await findJobsByTitle(businessId, jobTitle);
  if (matches.length === 0) return { found: false, jobTitle };
  return { found: true, matches: matches.map(summarizeJob) };
}

async function resolveJobScope(businessId, jobTitle) {
  const jobs = jobTitle ? await findJobsByTitle(businessId, jobTitle) : await fetchBusinessJobs(businessId);
  const scoped = jobTitle ? jobs : jobs.filter((j) => j.status !== "draft");
  const titleById = {};
  scoped.forEach((j) => (titleById[j.id] = j.title));
  return { jobs: scoped, jobIds: scoped.map((j) => j.id), titleById };
}

async function listApplicants(businessId, { jobTitle, limit } = {}) {
  const scope = await resolveJobScope(businessId, jobTitle);
  if (jobTitle && scope.jobs.length === 0) return { found: false, jobTitle };
  if (scope.jobs.length === 0) return { hasPostedJobs: false, applicants: [] };

  const take = Math.min(Math.max(Number(limit) || 5, 1), 10);
  const { data, error } = await supabase
    .from(APPLICATIONS_TABLE)
    .select("*")
    .in("job_id", scope.jobIds)
    .order("created_at", { ascending: false })
    .limit(take);

  if (error) {
    // Fallback: no applicant details, but counts per job still work.
    console.error("[geminiService] applications lookup failed:", error.message);
    return {
      detailsUnavailable: true,
      applicationsPerJob: scope.jobs.map((j) => ({ title: j.title, applications: j.application_count })),
    };
  }

  return {
    hasPostedJobs: true,
    count: data.length,
    applicants: data.map((a) => ({
      name: applicantName(a),
      job: scope.titleById[a.job_id] || "Unknown job",
      status: a.status || "new",
      appliedAt: a.created_at,
    })),
  };
}

async function getApplicationsSummary(businessId, { period } = {}) {
  const scope = await resolveJobScope(businessId, null);
  if (scope.jobs.length === 0) return { hasPostedJobs: false, total: 0 };

  const p = period || "week";
  let query = supabase
    .from(APPLICATIONS_TABLE)
    .select("job_id, created_at")
    .in("job_id", scope.jobIds)
    .limit(1000);
  const start = periodStart(p);
  if (start) query = query.gte("created_at", start.toISOString());

  const { data, error } = await query;
  if (error) {
    console.error("[geminiService] applications summary failed:", error.message);
    return {
      periodUnavailable: true,
      totalApplicationsAllTime: scope.jobs.reduce((n, j) => n + (j.application_count || 0), 0),
    };
  }

  const perJob = {};
  data.forEach((a) => {
    const title = scope.titleById[a.job_id] || "Unknown job";
    perJob[title] = (perJob[title] || 0) + 1;
  });

  return {
    hasPostedJobs: true,
    period: p,
    total: data.length,
    perJob: Object.entries(perJob).map(([title, applications]) => ({ title, applications })),
  };
}

function getDashboardLink({ section } = {}) {
  const key = DASHBOARD_PATHS[section] ? section : "overview";
  return { section: key, link: `${FRONTEND_URL}${DASHBOARD_PATHS[key]}` };
}

async function functionRouter(businessId, name, args, userMessage = "") {
  try {
    if (name === "getDashboardLink") return getDashboardLink(args);
    if (name === "getBusinessOverview") return await getBusinessOverview(businessId);
    if (name === "listJobs") return await listJobs(businessId, args);
    if (name === "getJobStats") return await getJobStats(businessId, args.jobTitle);
    if (name === "listApplicants") return await listApplicants(businessId, args);
    if (name === "getApplicationsSummary") return await getApplicationsSummary(businessId, args);
    if (name === "startJobPosting") return await startJobPosting(businessId, userMessage);
    return { error: "unknown_function" };
  } catch (err) {
    console.error(`[geminiService] tool ${name} failed:`, err);
    return { error: "lookup_failed" };
  }
}

// ── Gemini call with retry ─────────────────────────────────────────────────
async function generateWithRetry(contents, config) {
  let lastErr;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      return await ai.models.generateContent({ model: MODEL, contents, config });
    } catch (err) {
      lastErr = err;
      const isRetryable = RETRYABLE_STATUSES.includes(err?.status);
      if (!isRetryable || attempt === MAX_RETRIES) throw err;
      const delay = BASE_DELAY_MS * Math.pow(2, attempt);
      console.warn(`[geminiService] Gemini status ${err.status}, retrying in ${delay}ms…`);
      await sleep(delay);
    }
  }
  throw lastErr;
}

function buildSystemInstruction() {
  const today = new Date().toLocaleDateString("en-GB", {
    timeZone: "Africa/Lagos",
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
  });
  return (
    "You are the JobNix WhatsApp assistant for business owners. " +
    `Today is ${today} (Lagos time). ` +
    "You can report on: whether they have posted jobs, each job's state, views, clicks and applications, " +
    "who applied, and how many applied today, this week or this month. You can also start posting a new job. " +
    "Job states: live = approved and open; expired = approved but past its closing date; " +
    "pending = submitted and waiting for JobNix admin approval; draft = saved but not submitted or not yet paid; " +
    "rejected = declined by admin (a rejectionReason may be given). " +
    "RULES: " +
    "1) For greetings or small talk, reply in one or two friendly lines and say what they can ask. Call no tool. " +
    "2) For any question about their business, jobs or applicants, ALWAYS call the right tool first. " +
    "Never guess or invent numbers, names or reasons. " +
    "3) If hasPostedJobs is false, say they haven't posted a job yet (mention drafts if draftJobs > 0) and offer to post one right here (they just send 'post a job') or on their dashboard. " +
    "4) If they have jobs but zero applications, say so clearly and mention which job has the most views if useful. " +
    "5) If a job is pending, explain it is awaiting admin approval and won't get views until approved. " +
    "If rejected, share the rejectionReason if there is one. " +
    "6) If a job title isn't found, say so and offer to list their jobs. If several jobs match, list them and ask which one. " +
    "7) If a tool returns detailsUnavailable or periodUnavailable, give the counts you do have and say applicant names or dates aren't available right now. " +
    "8) If a tool returns an error, apologise briefly and ask them to try again. " +
    "9) If they want to post a job, call startJobPosting and reply with its firstMessage exactly as given, word for word. " +
    "The questions, price and payment link are handled automatically after that. Never quote a price yourself. " +
    "If they say they want to post on the website or dashboard instead, call getDashboardLink with section post_job " +
    "and send the link on its own line. " +
    "10) You cannot edit or delete jobs, review or message applicants, change the business profile, or see payment history in WhatsApp. " +
    "When they ask for any of these, call getDashboardLink with the closest section, send the link on its own line " +
    "and say in one short line that they can do it there after logging in. Never invent a link yourself. " +
    "Style: short, friendly plain text for WhatsApp. No markdown tables or headings. Simple • bullets are fine. " +
    "Never mention tools, databases or function names."
  );
}

/**
 * Answers a business owner's WhatsApp question using live data via function calling.
 *
 * @param {string} businessId
 * @param {string} userMessage
 * @param {Array<{role: 'user'|'model', parts: [{text: string}]}>} history
 */
export async function answerBusinessQuestion(businessId, userMessage, history = []) {
  // Gemini rejects history that starts with a "model" turn.
  const cleanHistory = [...history];
  while (cleanHistory.length && cleanHistory[0].role === "model") cleanHistory.shift();

  const contents = [...cleanHistory, { role: "user", parts: [{ text: userMessage }] }];
  const config = { tools, systemInstruction: buildSystemInstruction() };

  let response = await generateWithRetry(contents, config);

  let rounds = 0;
  while (response.functionCalls && response.functionCalls.length > 0 && rounds < MAX_TOOL_ROUNDS) {
    rounds++;
    contents.push(response.candidates[0].content);

    const responseParts = [];
    for (const call of response.functionCalls) {
      const output = await functionRouter(businessId, call.name, call.args || {}, userMessage);
      responseParts.push({ functionResponse: { name: call.name, response: { output }, id: call.id } });
    }
    contents.push({ role: "user", parts: responseParts });

    response = await generateWithRetry(contents, config);
  }

  return response.text || "Sorry, I couldn't put an answer together. Please try asking again.";
}