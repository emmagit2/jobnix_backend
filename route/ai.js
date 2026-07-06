// routes/ai.js
//
// Mount this in your existing app.js / server.js like:
//   import aiRoutes from "./routes/ai.js";
//   app.use("/api/ai", aiRoutes);
//
// Requires in .env:
//   GEMINI_API_KEY=your_key_here
//   GEMINI_MODEL=gemini-2.5-flash   (optional, this is the default)
//
// Requires installed: express, multer, @google/genai, dotenv
// NOTE: pdf-parse is NOT required anymore — Gemini reads the PDF directly.

import express from "express";
import multer from "multer";
import { GoogleGenAI } from "@google/genai";

const router = express.Router();

// ── Gemini client ────────────────────────────────────────────────────────
const apiKey = process.env.GEMINI_API_KEY;
if (!apiKey) {
  console.warn("[routes/ai.js] GEMINI_API_KEY is not set in .env");
}
const ai = new GoogleGenAI({ apiKey });
const MODEL = process.env.GEMINI_MODEL || "gemini-2.5-flash";

// Gemini occasionally returns 503 (model overloaded) or 429 (rate limited).
// Both are transient — retrying after a short backoff usually succeeds on
// the 2nd or 3rd attempt instead of failing the user's request outright.
const RETRYABLE_STATUSES = [503, 429];
const MAX_RETRIES = 2;
const BASE_DELAY_MS = 1000;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function generateJSON(contents, schema) {
  let lastErr;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const response = await ai.models.generateContent({
        model: MODEL,
        contents,
        config: {
          responseMimeType: "application/json",
          responseSchema: schema,
          temperature: 0.2,
        },
      });
      try {
        return JSON.parse(response.text);
      } catch (parseErr) {
        // Not retryable — the model responded, it just didn't give valid JSON.
        throw new Error(
          `Gemini returned non-JSON output: ${response.text?.slice(0, 300)}`
        );
      }
    } catch (err) {
      lastErr = err;
      const isRetryable = RETRYABLE_STATUSES.includes(err?.status);

      if (!isRetryable || attempt === MAX_RETRIES) {
        throw err;
      }

      const delay = BASE_DELAY_MS * Math.pow(2, attempt); // 1s, 2s, 4s...
      console.warn(
        `[routes/ai.js] Gemini call failed with status ${err.status} (attempt ${attempt + 1}/${MAX_RETRIES + 1}). Retrying in ${delay}ms…`
      );
      await sleep(delay);
    }
  }

  throw lastErr;
}

// Turn a thrown error into a clean, user-facing { status, message } pair.
// Centralized here so all three routes report errors the same way — and so
// the message actually lands in the field the frontend reads (`message`,
// via handleResponse() in jobApi.js — the old `{ error: ... }` shape meant
// every failure surfaced as a generic "Request failed" on the client).
function toClientError(err) {
  if (err?.status === 503) {
    return {
      status: 503,
      message: "Our AI is a bit busy right now — please try again in a moment.",
    };
  }
  if (err?.status === 429) {
    return {
      status: 429,
      message: "Too many requests right now — please wait a moment and try again.",
    };
  }
  return {
    status: 500,
    message: err?.message || "Something went wrong. Please try again.",
  };
}

// ── File upload (in-memory, no disk writes) ─────────────────────────────
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 8 * 1024 * 1024 }, // 8MB
  fileFilter: (req, file, cb) => {
    if (file.mimetype !== "application/pdf") {
      return cb(new Error("Only PDF files are accepted."));
    }
    cb(null, true);
  },
});

// ── Schemas ───────────────────────────────────────────────────────────────
const CV_SCHEMA = {
  type: "object",
  properties: {
    full_name: { type: "string" },
    email: { type: "string" },
    phone: { type: "string" },
    location: { type: "string" },
    headline: { type: "string" },
    years_of_experience: { type: "number" },
    skills: { type: "array", items: { type: "string" } },
    tools_and_technologies: { type: "array", items: { type: "string" } },
    education: {
      type: "array",
      items: {
        type: "object",
        properties: {
          institution: { type: "string" },
          degree: { type: "string" },
          field: { type: "string" },
          year: { type: "string" },
        },
      },
    },
    experience: {
      type: "array",
      items: {
        type: "object",
        properties: {
          company: { type: "string" },
          title: { type: "string" },
          start_date: { type: "string" },
          end_date: { type: "string" },
          summary: { type: "string" },
          key_achievements: { type: "array", items: { type: "string" } },
        },
      },
    },
    certifications: { type: "array", items: { type: "string" } },
    languages: { type: "array", items: { type: "string" } },
  },
  required: ["full_name", "skills", "experience"],
};

const MATCH_SCHEMA = {
  type: "object",
  properties: {
    overall_score: { type: "number" },
    skills_match_pct: { type: "number" },
    experience_match_pct: { type: "number" },
    keyword_match_pct: { type: "number" },
    matched_skills: { type: "array", items: { type: "string" } },
    missing_skills: { type: "array", items: { type: "string" } },
    strengths: { type: "array", items: { type: "string" } },
    gaps: { type: "array", items: { type: "string" } },
    recommendation: {
      type: "string",
      enum: ["strong_match", "possible_match", "weak_match"],
    },
    summary: { type: "string" },
  },
  required: [
    "overall_score",
    "skills_match_pct",
    "experience_match_pct",
    "keyword_match_pct",
    "matched_skills",
    "missing_skills",
    "recommendation",
  ],
};

const GAP_SCHEMA = {
  type: "object",
  properties: {
    gaps: {
      type: "array",
      items: {
        type: "object",
        properties: {
          title: { type: "string" },
          priority: { type: "string", enum: ["High", "Medium", "Low"] },
          progress_pct: {
            type: "number",
            description: "0-100, how much of this skill the candidate already has",
          },
          fix: {
            type: "string",
            description:
              "2-4 concrete, actionable sentences: specific resource/course + realistic time estimate",
          },
        },
        required: ["title", "priority", "progress_pct", "fix"],
      },
    },
  },
  required: ["gaps"],
};

// ── POST /parse ───────────────────────────────────────────────────────────
// multipart/form-data, field name: "cv"
// Sends the raw PDF straight to Gemini (multimodal input) instead of
// extracting text locally — no pdf-parse dependency needed.
router.post("/parse", upload.single("cv"), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ message: "No PDF file uploaded (field name must be 'cv')." });
    }

    const promptText = `You are an expert technical recruiter and resume parser.
Extract structured information from the attached resume PDF and return it
according to the schema.

Rules:
- Normalize skills to clean, deduplicated Title Case entries.
- Separate soft/professional skills from concrete tools/technologies where possible.
- If a field is not present, omit it or use an empty array/string. Don't invent data.
- Estimate years_of_experience from work history dates if not explicitly stated.`;

    const contents = [
      {
        role: "user",
        parts: [
          { text: promptText },
          {
            inlineData: {
              mimeType: "application/pdf",
              data: req.file.buffer.toString("base64"),
            },
          },
        ],
      },
    ];

    const parsed = await generateJSON(contents, CV_SCHEMA);
    res.json({ success: true, data: parsed });
  } catch (err) {
    console.error("[/api/ai/parse] error:", err);
    const { status, message } = toClientError(err);
    res.status(status).json({ message });
  }
});

// ── POST /match ───────────────────────────────────────────────────────────
// JSON body: { cv: <parsed CV object from /parse>, jobDescription: "..." }
router.post("/match", express.json({ limit: "1mb" }), async (req, res) => {
  try {
    const { cv, jobDescription } = req.body;
    if (!cv || !jobDescription || jobDescription.trim().length < 10) {
      return res.status(400).json({ message: "Both 'cv' (object) and 'jobDescription' (string) are required." });
    }

    const prompt = `You are an expert technical recruiter. Compare the candidate's
parsed resume data against the job description and score the fit according to
the schema. Score sub-metrics (skills_match_pct, experience_match_pct,
keyword_match_pct) independently, 0-100 each. overall_score should reasonably
reflect a weighted blend of those three.

Be specific and grounded only in the data given — never invent skills the
candidate doesn't have.

Candidate resume data (JSON):
${JSON.stringify(cv, null, 2)}

Job description:
"""
${jobDescription}
"""`;

    const result = await generateJSON(prompt, MATCH_SCHEMA);
    res.json({ success: true, data: result });
  } catch (err) {
    console.error("[/api/ai/match] error:", err);
    const { status, message } = toClientError(err);
    res.status(status).json({ message });
  }
});

// ── POST /gap-analysis ───────────────────────────────────────────────────
// JSON body: { cv: <parsed CV object>, jobDescription: "..." }
router.post("/gap-analysis", express.json({ limit: "1mb" }), async (req, res) => {
  try {
    const { cv, jobDescription } = req.body;
    if (!cv || !jobDescription || jobDescription.trim().length < 10) {
      return res.status(400).json({ message: "Both 'cv' (object) and 'jobDescription' (string) are required." });
    }

    const prompt = `You are a career coach helping a candidate close skill gaps for
a specific job. Compare their resume data against the job description and list
the concrete gaps according to the schema.

For each gap's "fix" field: name a specific free or low-cost resource (course,
docs, certification) and a realistic time estimate. Keep each fix to 2-4
sentences, practical and specific — not generic advice.

Order gaps by priority (High first). Only include real gaps grounded in the
job description — don't invent requirements that aren't there.

Candidate resume data (JSON):
${JSON.stringify(cv, null, 2)}

Job description:
"""
${jobDescription}
"""`;

    const result = await generateJSON(prompt, GAP_SCHEMA);
    res.json({ success: true, data: result.gaps });
  } catch (err) {
    console.error("[/api/ai/gap-analysis] error:", err);
    const { status, message } = toClientError(err);
    res.status(status).json({ message });
  }
});

export default router;