// lib/geminiService.js
//
// WhatsApp business-stats assistant. Uses the SAME @google/genai package as
// routes/ai.js (GoogleGenAI class, ai.models.generateContent) — NOT the
// older @google/generative-ai package. Since @google/genai is already a
// dependency (routes/ai.js uses it), this adds zero new packages.
import { GoogleGenAI } from "@google/genai";
import * as jobsRepo from "../lib/jobsRepo.js";

const apiKey = process.env.GEMINI_API_KEY;
if (!apiKey) {
  console.warn("[lib/geminiService.js] GEMINI_API_KEY is not set in .env");
}
const ai = new GoogleGenAI({ apiKey });
const MODEL = process.env.GEMINI_MODEL || "gemini-2.5-flash";

// Same transient-error handling as routes/ai.js's generateJSON.
const RETRYABLE_STATUSES = [503, 429];
const MAX_RETRIES = 2;
const BASE_DELAY_MS = 1000;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Function-calling tools Gemini can invoke to answer questions like "how
// many people viewed the Marketing Intern job" or "how many applied this
// week". Gemini decides which function(s) it needs based on the question.
const tools = [
  {
    functionDeclarations: [
      {
        name: "listJobs",
        description: "List all jobs posted by this business, with basic stats for each.",
        parameters: { type: "object", properties: {} },
      },
      {
        name: "getJobStats",
        description:
          "Get detailed stats (views, clicks, applications) for one specific job, matched by title (partial match allowed).",
        parameters: {
          type: "object",
          properties: {
            jobTitle: {
              type: "string",
              description: "The title or partial title of the job the user is asking about",
            },
          },
          required: ["jobTitle"],
        },
      },
    ],
  },
];

function deriveStatus(job) {
  if (!job.deadline) return "active";
  return new Date(job.deadline) >= new Date(new Date().toDateString()) ? "active" : "expired";
}

async function listJobs(businessId) {
  const jobs = await jobsRepo.listByBusiness(businessId);
  return jobs.map((j) => ({
    title: j.title,
    status: deriveStatus(j),
    views: j.view_count,
    clicks: j.click_count,
    applications: j.application_count,
  }));
}

async function getJobStats(businessId, jobTitle) {
  const job = await jobsRepo.findByTitleForBusiness(businessId, jobTitle);
  if (!job) return { found: false, jobTitle };
  return {
    found: true,
    title: job.title,
    status: deriveStatus(job),
    views: job.view_count,
    clicks: job.click_count,
    applications: job.application_count,
  };
}

async function functionRouter(businessId, name, args) {
  if (name === "listJobs") return listJobs(businessId);
  if (name === "getJobStats") return getJobStats(businessId, args.jobTitle);
  return { error: "unknown_function" };
}

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
      console.warn(
        `[lib/geminiService.js] Gemini call failed with status ${err.status} (attempt ${attempt + 1}/${MAX_RETRIES + 1}). Retrying in ${delay}ms…`
      );
      await sleep(delay);
    }
  }
  throw lastErr;
}

/**
 * Answers a business owner's WhatsApp question in natural language, using
 * live job data via function calling.
 *
 * @param {string} businessId
 * @param {string} userMessage - raw WhatsApp message text
 * @param {Array<{role: 'user'|'model', parts: [{text: string}]}>} history - recent chat turns
 */
export async function answerBusinessQuestion(businessId, userMessage, history = []) {
  const contents = [...history, { role: "user", parts: [{ text: userMessage }] }];

  const config = {
    tools,
    systemInstruction:
      "You are the JobNix WhatsApp assistant. You help business owners quickly check stats " +
      "on the jobs they've posted (views, clicks, applications). Always use the provided " +
      "functions to fetch real numbers before answering — never guess or invent numbers. " +
      "Keep replies short and friendly, suitable for WhatsApp (a few lines max, no markdown tables).",
  };

  let response = await generateWithRetry(contents, config);

  // Handle one or more rounds of function calling.
  while (response.functionCalls && response.functionCalls.length > 0) {
    contents.push(response.candidates[0].content);

    const responseParts = [];
    for (const call of response.functionCalls) {
      const output = await functionRouter(businessId, call.name, call.args || {});
      responseParts.push({ functionResponse: { name: call.name, response: output, id: call.id } });
    }
    contents.push({ role: "user", parts: responseParts });

    response = await generateWithRetry(contents, config);
  }

  return response.text;
}