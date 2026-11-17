// lib/jobMatching.js
//
// Pure matching logic: no database, no email. The cron emails and the
// dashboard "matched jobs" list both call matchJobsForUser, so they always
// agree on what a "match" is.
//
// A job matches a user when ALL of these hold:
//   1. Kind of job   - fits at least one of the user's alert_categories
//   2. Place         - fits the user's job_locations (empty = anywhere)
//   3. Job type      - fits one of the user's roles (empty = any job)
//
// Matches are then ranked so the best ones come first in the email.

// ── Text helpers ─────────────────────────────────────────────────────────────
const STOP = new Set(["and", "the", "for", "of", "a", "an", "in", "at", "to"]);

export const norm = (s) =>
  String(s ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

// "sales" and "sale" should count as the same word
const stem = (w) => (w.length > 3 && w.endsWith("s") ? w.slice(0, -1) : w);
const tokens = (s) => norm(s).split(" ").filter((w) => w && !STOP.has(w)).map(stem);

// Whole-word search, so "niger" does not match "nigeria" and "oyo" does not match "boyo"
const hasPhrase = (hayNorm, phrase) => ` ${hayNorm} `.includes(` ${phrase} `);

// ── Roles ────────────────────────────────────────────────────────────────────
// "Customer service" matches "Customer Service Representative".
// "Driver" matches "Drivers needed". Every word of the role must appear.
export function roleMatches(role, text) {
  const hay = norm(text);
  const phrase = norm(role);
  if (!phrase || !hay) return false;
  if (hasPhrase(hay, phrase)) return true;
  const hayTokens = new Set(tokens(text));
  const roleTokens = tokens(role);
  return roleTokens.length > 0 && roleTokens.every((t) => hayTokens.has(t));
}

// ── Places ───────────────────────────────────────────────────────────────────
// Extra names for the two biggest job markets, so a job posted as just
// "Garki" or "Lekki" still matches someone who picked FCT (Abuja) or Lagos.
const EXTRA_AREAS = {
  fct: [
    "abuja", "garki", "wuse", "gwarinpa", "maitama", "asokoro", "jabi", "utako",
    "kubwa", "lugbe", "nyanya", "karu", "gwagwalada", "kuje", "bwari", "lokogoma",
    "life camp", "central business district", "katampe", "durumi", "apo", "mpape",
  ],
  lagos: [
    "ikeja", "lekki", "yaba", "surulere", "ajah", "ikorodu", "victoria island",
    "ikoyi", "oshodi", "gbagada", "maryland", "festac", "ojodu", "magodo", "isolo",
    "mushin", "agege", "alimosho", "apapa", "sangotedo", "badagry", "epe",
  ],
};

// "FCT (Abuja)" -> ["fct", "abuja", ...areas]
export function placeAliases(place) {
  const m = String(place).match(/^(.*?)\s*\((.*?)\)\s*$/);
  const base = (m ? [m[1], m[2]] : [place]).map(norm).filter(Boolean);
  return [...base, ...(EXTRA_AREAS[base[0]] || [])];
}

const jobPlaceText = (job) =>
  norm([job.location, job.candidate_state, ...(job.candidate_locations || [])].join(" "));

function jobInPlaces(job, places) {
  const hay = jobPlaceText(job);
  return places.some((p) => placeAliases(p).some((a) => hasPhrase(hay, a)));
}

// ── Job kinds ────────────────────────────────────────────────────────────────
const isRemoteJob = (job) =>
  /\bremote\b/.test(norm([job.location, job.job_type, job.title].join(" ")));

const isInternJob = (job) =>
  /\bintern(s|ship|ships)?\b/.test(norm([job.title, job.job_type, job.role_category].join(" ")));

// Must match the labels in the Settings page (ALERT_CATEGORIES)
const CATEGORY_TESTS = {
  "Formal roles": (j) => j.work_type !== "informal",
  "Informal / gig work": (j) => j.work_type === "informal",
  "Remote": isRemoteJob,
  "On-site": (j) => !isRemoteJob(j),
  "Internships": isInternJob,
};

// ── Matching ─────────────────────────────────────────────────────────────────
const NO_MATCH = { matched: false, score: 0, reasons: [] };

/**
 * @param job   a row from public.jobs
 * @param user  a row from public.user_profiles
 * @param opts  { ignoreCategories } - urgent alerts skip the "kinds of jobs" check
 */
export function matchJob(job, user, opts = {}) {
  const reasons = [];
  let score = 0;

  // 1. Kind of job
  const cats = Array.isArray(user.alert_categories) ? user.alert_categories : [];
  if (!opts.ignoreCategories && !cats.some((c) => CATEGORY_TESTS[c]?.(job))) return NO_MATCH;

  // 2. Place (none chosen = jobs from everywhere)
  const places = Array.isArray(user.job_locations) ? user.job_locations : [];
  if (places.length) {
    const states = places.filter((p) => p !== "Remote");
    const inState = states.length > 0 && jobInPlaces(job, states);
    if (isRemoteJob(job)) {
      const wantsRemote = places.includes("Remote") || cats.includes("Remote");
      if (!wantsRemote && !inState) return NO_MATCH;
      reasons.push("Remote");
    } else {
      if (!inState) return NO_MATCH;
      reasons.push(job.location || "In your area");
    }
    score += 2;
  }

  // 3. Job type (roles the person picked or added themselves)
  const roles = (Array.isArray(user.roles) ? user.roles : []).filter(Boolean);
  if (roles.length) {
    const text = [job.title, job.role_category].join(" ");
    const hit = roles.find((r) => roleMatches(r, text));
    if (!hit) return NO_MATCH;
    score += 4;
    reasons.push(`Matches ${hit}`);
  }

  // Ranking extras
  const city = String(user.location || "").split(",")[0];
  if (city && hasPhrase(jobPlaceText(job), norm(city))) score += 2; // same area they live in
  if (job.is_urgent) score += 1;
  if (job.deadline) {
    const daysLeft = (new Date(job.deadline) - Date.now()) / 86400000;
    if (daysLeft >= 0 && daysLeft <= 3) score += 1; // closing soon
  }

  return { matched: true, score, reasons };
}

export function matchJobsForUser(jobs, user, { limit = Infinity, ...opts } = {}) {
  return jobs
    .map((job) => ({ job, ...matchJob(job, user, opts) }))
    .filter((m) => m.matched)
    .sort(
      (a, b) =>
        b.score - a.score ||
        new Date(b.job.created_at || 0) - new Date(a.job.created_at || 0)
    )
    .slice(0, limit);
}