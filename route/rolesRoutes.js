// routes/roles.js
// Mount: app.use("/api/roles", rolesRouter)
//
// POST /api/roles/validate  { title: "Machne Operatr" }
//   -> { valid: false, suggestion: "Machine Operator" }   (likely a typo of an existing title)
//   -> { valid: true,  canonical: "Machine Operator" }    (exact match, case-insensitive)
//   -> { valid: true,  canonical: "Drone Pilot" }          (genuinely new, well-formed title —
//                                                            gets added to job_titles for future users)
//   -> { valid: false, reason: "..." }                    (fails basic formatting rules)

import express from "express";
import { supabase } from "../config/supabase.js"; // the service-role client

const router = express.Router();

// --- Levenshtein edit distance, normalized to a 0..1 similarity score ---
function levenshtein(a, b) {
  const m = a.length, n = b.length;
  const dp = Array.from({ length: m + 1 }, (_, i) => [i, ...Array(n).fill(0)]);
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] = a[i - 1] === b[j - 1]
        ? dp[i - 1][j - 1]
        : 1 + Math.min(dp[i - 1][j - 1], dp[i - 1][j], dp[i][j - 1]);
    }
  }
  return dp[m][n];
}
function similarity(a, b) {
  const maxLen = Math.max(a.length, b.length);
  if (maxLen === 0) return 1;
  return 1 - levenshtein(a, b) / maxLen;
}

// --- Basic formatting sanity check, before even hitting the DB ---
// Letters, spaces, and a few punctuation marks common in job titles (/, -, &).
// Rejects pure numbers, random symbol strings, single characters, etc.
const TITLE_SHAPE = /^[A-Za-z][A-Za-z\s/&-]{1,58}[A-Za-z)]$/;

router.post("/validate", async (req, res) => {
  const raw = (req.body?.title || "").trim().replace(/\s+/g, " ");

  if (raw.length < 2) {
    return res.status(400).json({ valid: false, reason: "Too short." });
  }
  if (!TITLE_SHAPE.test(raw)) {
    return res.status(400).json({ valid: false, reason: "Doesn't look like a job title." });
  }

  const { data: titles, error } = await supabase.from("job_titles").select("title");
  if (error) return res.status(500).json({ error: error.message });

  const lowerRaw = raw.toLowerCase();

  // Exact match (case-insensitive) — already a known title.
  const exact = titles.find((t) => t.title.toLowerCase() === lowerRaw);
  if (exact) return res.json({ valid: true, canonical: exact.title });

  // Find the closest existing title. High similarity + not an exact match
  // usually means a typo of something that already exists.
  let best = null;
  let bestScore = 0;
  for (const t of titles) {
    const score = similarity(lowerRaw, t.title.toLowerCase());
    if (score > bestScore) {
      bestScore = score;
      best = t.title;
    }
  }

  const TYPO_THRESHOLD = 0.82; // tune based on false-positive/negative reports
  if (bestScore >= TYPO_THRESHOLD) {
    return res.json({ valid: false, suggestion: best });
  }

  // Genuinely new, well-formed title — add it to the canonical list so
  // future users searching for the same thing find it instead of
  // re-typing it (this is the "list should grow" part).
  const { error: insertError } = await supabase
    .from("job_titles")
    .insert({ title: raw })
    .select()
    .single();

  // A race with another user adding the same title concurrently isn't a
  // real error — ignore unique-violation, surface anything else.
  if (insertError && insertError.code !== "23505") {
    return res.status(500).json({ error: insertError.message });
  }

  return res.json({ valid: true, canonical: raw });
});

export default router;