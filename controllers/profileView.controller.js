// controllers/profileView.controller.js
//
// Public, view-only candidate profile pages. Ways in:
//   1. UNIQUE LINK — a random 64-char token the jobseeker creates in
//      Settings > Privacy and sharing. Stored in user_profiles.share_links,
//      can be cancelled or expire.
//   2. SIGNED TOKEN — the JWT link sent after someone applies to a job.
//      Keeps working as before, except when the profile is Hidden.
//   3. USERNAME — jobnix.ng/u/username. Only works when the profile is Public.
//
// Settings enforced here (all saved by SettingsPage.jsx):
//   profile_visibility: 'public' | 'private_link' | 'hidden'
//   cv_visibility:      'view' | 'download' | 'hidden'
//
// The raw Supabase storage URL for the CV is never exposed — the CV is
// proxy-streamed through this server, and every request re-checks the
// settings, so changing a setting takes effect immediately.

import { supabase } from "../config/supabase.js";
import jwt from "jsonwebtoken";

const PROFILE_TOKEN_SECRET = process.env.PROFILE_VIEW_JWT_SECRET || process.env.RECRUITER_JWT_SECRET;

const SHARE_TOKEN_RE = /^[a-f0-9]{64}$/;
const NOT_AVAILABLE = "This profile isn't available.";
const BAD_LINK = "This link is invalid, cancelled or has expired.";

// ── Helpers ─────────────────────────────────────────────────────────────────

const isLinkActive = (link) =>
  !!link &&
  !link.revoked &&
  (!link.expires_at || new Date(link.expires_at) > new Date());

// Strip everything a visitor must never receive: the raw CV url, the unique
// link tokens (they are the keys to other people's access!), and the
// owner's private settings.
function toPublicProfile(profile) {
  const {
    cv_url,
    share_links,
    safety_enabled,
    safety_contact_name,
    safety_contact_phone,
    interview_location,
    interview_autofill,
    alerts_enabled,
    alert_frequency,
    alert_day,
    alert_categories,
    urgent_alerts,
    ...safe
  } = profile;
  return safe;
}

async function loadRelated(userId) {
  const [
    { data: workExperience },
    { data: education },
    { data: certifications },
    { data: skills },
    { data: links },
    { data: jobPreferences },
  ] = await Promise.all([
    supabase.from("user_work_experience").select("*").eq("user_id", userId).order("sort_order"),
    supabase.from("user_education").select("*").eq("user_id", userId).order("sort_order"),
    supabase.from("user_certifications").select("*").eq("user_id", userId).order("sort_order"),
    supabase.from("user_skills").select("*").eq("user_id", userId).maybeSingle(),
    supabase.from("user_links").select("*").eq("user_id", userId).maybeSingle(),
    supabase.from("user_job_preferences").select("*").eq("user_id", userId).maybeSingle(),
  ]);
  return { workExperience, education, certifications, skills, links, jobPreferences };
}

// Builds the JSON response, applying the CV setting.
// cvBase is the proxied CV endpoint for this link, e.g. ".../u/jane/cv".
async function buildProfileResponse(profile, cvBase) {
  const related = await loadRelated(profile.id);

  const cvVisibility = profile.cv_visibility || "view";
  const hasCv = !!profile.cv_url && cvVisibility !== "hidden";

  return {
    profile: toPublicProfile(profile),
    has_cv: hasCv,
    cv_visibility: cvVisibility,
    // The candidate has a CV on file but chose to hide it. We say so (without
    // sending any file link) so the page can show a "locked" card instead of
    // silently showing nothing.
    cv_locked: !!profile.cv_url && cvVisibility === "hidden",
    cv_view_url: hasCv ? cvBase : null,
    cv_download_url: hasCv && cvVisibility === "download" ? `${cvBase}?download=1` : null,
    work_experience: related.workExperience || [],
    education: related.education || [],
    certifications: related.certifications || [],
    skills: related.skills || { technical: [], soft: [], trade: [] },
    links: related.links || {},
    job_preferences: related.jobPreferences || {},
  };
}

// Finds the profile a token points at and checks the owner's settings.
// Returns { profile } or { status, message }.
async function resolveByToken(token) {
  // A) Unique link created in Settings
  if (SHARE_TOKEN_RE.test(token)) {
    const { data, error } = await supabase
      .from("user_profiles")
      .select("*")
      // jsonb column: the value must be a JSON string. Passing an array makes
      // supabase-js build a Postgres array literal, which breaks the query.
      .contains("share_links", JSON.stringify([{ token }]))
      .maybeSingle();

    if (error) console.error("[profile-view] share link lookup failed:", error.message);
    if (error || !data) return { status: 404, message: BAD_LINK };
    if (data.profile_visibility === "hidden") return { status: 404, message: NOT_AVAILABLE };

    const link = (data.share_links || []).find((l) => l.token === token);
    if (!isLinkActive(link)) return { status: 404, message: BAD_LINK };

    return { profile: data };
  }

  // B) Signed JWT sent after someone applies (keeps working as before)
  let payload;
  try {
    payload = jwt.verify(token, PROFILE_TOKEN_SECRET);
  } catch {
    return { status: 401, message: BAD_LINK };
  }
  if (payload.kind !== "profile-view" || !payload.uid) {
    return { status: 401, message: "This link is invalid." };
  }

  const { data, error } = await supabase
    .from("user_profiles")
    .select("*")
    .eq("id", payload.uid)
    .single();

  if (error || !data) return { status: 404, message: "Profile not found." };
  if (data.profile_visibility === "hidden") return { status: 404, message: NOT_AVAILABLE };

  return { profile: data };
}

// Finds the profile for a public /u/:username link. Only Public profiles.
async function resolveByUsername(username) {
  const { data, error } = await supabase
    .from("user_profiles")
    .select("*")
    .eq("username", username)
    .single();

  // Same message whether it doesn't exist or isn't public, so the
  // response doesn't reveal that a username is taken.
  if (error || !data) return { status: 404, message: NOT_AVAILABLE };
  if ((data.profile_visibility || "public") !== "public") {
    return { status: 404, message: NOT_AVAILABLE };
  }
  return { profile: data };
}

// Streams the CV, honouring cv_visibility.
//   hidden   -> 404
//   view     -> always inline (a ?download=1 is ignored)
//   download -> inline, or as an attachment with ?download=1
async function streamCv(req, res, profile) {
  const cvVisibility = profile.cv_visibility || "view";

  if (!profile.cv_url || cvVisibility === "hidden") {
    return res.status(404).json({ success: false, message: "No CV on file." });
  }

  const fileRes = await fetch(profile.cv_url);
  if (!fileRes.ok) {
    return res.status(502).json({ success: false, message: "Could not load CV file." });
  }

  const wantsDownload = req.query.download === "1" && cvVisibility === "download";
  const safeName =
    (profile.full_name || "cv").replace(/[^a-zA-Z0-9 _-]/g, "").trim().replace(/\s+/g, "_") || "cv";

  const contentType = fileRes.headers.get("content-type") || "application/pdf";
  const buffer = Buffer.from(await fileRes.arrayBuffer());

  res.setHeader("Content-Type", contentType);
  res.setHeader(
    "Content-Disposition",
    wantsDownload ? `attachment; filename="${safeName}_CV.pdf"` : `inline; filename="cv.pdf"`
  );
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Cache-Control", "private, no-store");
  return res.send(buffer);
}

const hostBase = (req) => `${req.protocol}://${req.get("host")}/api/profile-view`;

// =============================
// POST /api/profile-view/generate
// Auth required — a jobseeker generates (or re-fetches) their own
// signed profile TOKEN link (used for recruiter-application emails —
// separate from the unique links made in Settings).
// =============================
export const generateProfileViewLink = async (req, res) => {
  try {
    const userId = req.user.id;

    const token = jwt.sign({ uid: userId, kind: "profile-view" }, PROFILE_TOKEN_SECRET);
    const origin = process.env.PUBLIC_SITE_URL || "https://jobnix.ng";
    const url = `${origin}/profile-view/${token}`;

    return res.json({ success: true, data: { token, url } });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
};

// =============================
// GET /api/profile-view/:token
// PUBLIC — unique link or signed token. See resolveByToken().
// =============================
export const getProfileByToken = async (req, res) => {
  try {
    const { token } = req.params;
    const found = await resolveByToken(token);
    if (!found.profile) {
      return res.status(found.status).json({ success: false, message: found.message });
    }

    const data = await buildProfileResponse(found.profile, `${hostBase(req)}/${token}/cv`);
    return res.json({ success: true, data });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
};

// =============================
// GET /api/profile-view/:token/cv
// PUBLIC — streams the CV for a token link, honouring cv_visibility.
// =============================
export const streamProfileCv = async (req, res) => {
  try {
    const found = await resolveByToken(req.params.token);
    if (!found.profile) {
      return res.status(found.status).json({ success: false, message: found.message });
    }
    return await streamCv(req, res, found.profile);
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
};

// =============================
// GET /api/profile-view/username-available/:username
// PUBLIC — live availability check while the user is typing in
// UsernameClaimCard (ProfileSetup.jsx).
// =============================
export const checkUsernameAvailable = async (req, res) => {
  try {
    const raw = (req.params.username || "").toLowerCase().trim();
    if (!/^[a-z0-9-]{3,30}$/.test(raw)) {
      return res.json({ success: true, data: { available: false, reason: "invalid_format" } });
    }
    const { data, error } = await supabase
      .from("user_profiles")
      .select("id")
      .eq("username", raw)
      .maybeSingle();
    if (error) throw error;
    return res.json({ success: true, data: { available: !data } });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
};

// =============================
// PATCH /api/profile-view/username
// Auth required — claim or change your own username. This becomes the
// permanent jobnix.ng/u/username link shown in ProfileSetup's sidebar.
// =============================
export const setUsername = async (req, res) => {
  try {
    const userId = req.user.id;
    const raw = (req.body.username || "").toLowerCase().trim();
    if (!/^[a-z0-9-]{3,30}$/.test(raw)) {
      return res.status(400).json({
        success: false,
        message: "Username must be 3-30 characters: lowercase letters, numbers, and hyphens only.",
      });
    }
    const { data: existing } = await supabase
      .from("user_profiles")
      .select("id")
      .eq("username", raw)
      .maybeSingle();
    if (existing && existing.id !== userId) {
      return res.status(409).json({ success: false, message: "That username is already taken." });
    }
    const { data, error } = await supabase
      .from("user_profiles")
      .update({ username: raw })
      .eq("id", userId)
      .select("username")
      .single();
    if (error) throw error;
    return res.json({ success: true, data: { username: data.username } });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
};

// =============================
// GET /api/profile-view/u/:username
// PUBLIC — jobnix.ng/u/username. Only works when profile_visibility is
// 'public'; 'private_link' and 'hidden' profiles return 404.
// =============================
export const getProfileByUsername = async (req, res) => {
  try {
    const username = (req.params.username || "").toLowerCase().trim();
    const found = await resolveByUsername(username);
    if (!found.profile) {
      return res.status(found.status).json({ success: false, message: found.message });
    }

    const data = await buildProfileResponse(found.profile, `${hostBase(req)}/u/${username}/cv`);
    return res.json({ success: true, data });
  } catch (err) {
    console.error("[profile-view] getProfileByUsername threw:", err);
    return res.status(500).json({ success: false, message: err.message });
  }
};

// =============================
// GET /api/profile-view/u/:username/cv
// PUBLIC — streams the CV for a username link, honouring cv_visibility.
// =============================
export const streamProfileCvByUsername = async (req, res) => {
  try {
    const username = (req.params.username || "").toLowerCase().trim();
    const found = await resolveByUsername(username);
    if (!found.profile) {
      return res.status(found.status).json({ success: false, message: found.message });
    }
    return await streamCv(req, res, found.profile);
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
};