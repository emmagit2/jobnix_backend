// controllers/profileView.controller.js
//
// Public, view-only candidate profile pages. Two ways in now:
//   1. TOKEN — the link generated after someone applies to a job. Signed
//      JWT, carries the candidate's user_id, doesn't require a username to
//      exist. Used for recruiter-application emails.
//   2. USERNAME — the permanent, human-readable link
//      (jobnix.ng/u/username) a jobseeker claims and shares themselves.
//
// Both must never expose the raw Supabase storage URL for the CV — we
// proxy-stream it through our own server with an inline disposition — and
// neither requires the viewer to have an account.

import { supabase } from "../config/supabase.js";
import jwt from "jsonwebtoken";

const PROFILE_TOKEN_SECRET = process.env.PROFILE_VIEW_JWT_SECRET || process.env.RECRUITER_JWT_SECRET;

// =============================
// POST /api/profile-view/generate
// Auth required — a jobseeker generates (or re-fetches) their own
// shareable, view-only profile TOKEN link (used for recruiter-application
// emails — separate from the username link below).
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
// PUBLIC — no auth. Access is gated purely by possession of a valid,
// correctly-signed token. Returns the full profile: base info + all
// related tables, but NEVER the raw cv_url — only a proxied /cv link.
// =============================
export const getProfileByToken = async (req, res) => {
  try {
    const { token } = req.params;

    let payload;
    try {
      payload = jwt.verify(token, PROFILE_TOKEN_SECRET);
    } catch {
      return res.status(401).json({ success: false, message: "This link is invalid or has expired." });
    }
    if (payload.kind !== "profile-view" || !payload.uid) {
      return res.status(401).json({ success: false, message: "This link is invalid." });
    }

    const userId = payload.uid;

    const [
      { data: profile, error: profileErr },
      { data: workExperience },
      { data: education },
      { data: certifications },
      { data: skills },
      { data: links },
      { data: jobPreferences },
    ] = await Promise.all([
      supabase.from("user_profiles").select("*").eq("id", userId).single(),
      supabase.from("user_work_experience").select("*").eq("user_id", userId).order("sort_order"),
      supabase.from("user_education").select("*").eq("user_id", userId).order("sort_order"),
      supabase.from("user_certifications").select("*").eq("user_id", userId).order("sort_order"),
      supabase.from("user_skills").select("*").eq("user_id", userId).maybeSingle(),
      supabase.from("user_links").select("*").eq("user_id", userId).maybeSingle(),
      supabase.from("user_job_preferences").select("*").eq("user_id", userId).maybeSingle(),
    ]);

    if (profileErr || !profile) {
      return res.status(404).json({ success: false, message: "Profile not found." });
    }

    // Never send the raw cv_url to the client — only whether a CV exists,
    // plus the proxied view endpoint the frontend should embed.
    const { cv_url, ...safeProfile } = profile;

    return res.json({
      success: true,
      data: {
        profile: safeProfile,
        has_cv: !!cv_url,
        cv_view_url: cv_url ? `${req.protocol}://${req.get("host")}/api/profile-view/${token}/cv` : null,
        work_experience: workExperience || [],
        education: education || [],
        certifications: certifications || [],
        skills: skills || { technical: [], soft: [], trade: [] },
        links: links || {},
        job_preferences: jobPreferences || {},
      },
    });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
};

// =============================
// GET /api/profile-view/:token/cv
// PUBLIC — streams the candidate's CV inline (view-only). The browser
// renders it in an embedded viewer instead of triggering "Save As", and
// the frontend never receives a direct, copyable storage link.
// Note: a determined visitor can still screenshot or use browser devtools
// to save any inline-rendered file — this raises the bar, it can't make
// viewing content on the open web literally un-savable.
// =============================
export const streamProfileCv = async (req, res) => {
  try {
    const { token } = req.params;

    let payload;
    try {
      payload = jwt.verify(token, PROFILE_TOKEN_SECRET);
    } catch {
      return res.status(401).json({ success: false, message: "This link is invalid or has expired." });
    }
    if (payload.kind !== "profile-view" || !payload.uid) {
      return res.status(401).json({ success: false, message: "This link is invalid." });
    }

    const { data: profile, error } = await supabase
      .from("user_profiles")
      .select("cv_url, full_name")
      .eq("id", payload.uid)
      .single();

    if (error || !profile?.cv_url) {
      return res.status(404).json({ success: false, message: "No CV on file." });
    }

    const fileRes = await fetch(profile.cv_url);
    if (!fileRes.ok) {
      return res.status(502).json({ success: false, message: "Could not load CV file." });
    }

    const contentType = fileRes.headers.get("content-type") || "application/pdf";
    const buffer = Buffer.from(await fileRes.arrayBuffer());

    res.setHeader("Content-Type", contentType);
    res.setHeader("Content-Disposition", `inline; filename="cv.pdf"`);
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Cache-Control", "private, no-store");
    return res.send(buffer);
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
// PUBLIC — same shape as getProfileByToken, keyed by username instead of
// a token. This is what the jobnix.ng/u/username link resolves to.
// =============================
export const getProfileByUsername = async (req, res) => {
  try {
    const username = (req.params.username || "").toLowerCase().trim();

    // --- DEBUG LOG: confirm the request is actually reaching this handler ---
    console.log("[profile-view] HIT getProfileByUsername:", username);

    const { data: profile, error: profileErr } = await supabase
      .from("user_profiles")
      .select("*")
      .eq("username", username)
      .single();

    // --- DEBUG LOG: confirm the Supabase query returned ---
    console.log("[profile-view] Supabase query resolved. error:", profileErr?.message, "found profile:", !!profile);

    if (profileErr || !profile) {
      return res.status(404).json({ success: false, message: "This profile doesn't exist." });
    }

    const userId = profile.id;

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

    const { cv_url, ...safeProfile } = profile;

    return res.json({
      success: true,
      data: {
        profile: safeProfile,
        has_cv: !!cv_url,
        cv_view_url: cv_url ? `${req.protocol}://${req.get("host")}/api/profile-view/u/${username}/cv` : null,
        work_experience: workExperience || [],
        education: education || [],
        certifications: certifications || [],
        skills: skills || { technical: [], soft: [], trade: [] },
        links: links || {},
        job_preferences: jobPreferences || {},
      },
    });
  } catch (err) {
    console.error("[profile-view] getProfileByUsername threw:", err);
    return res.status(500).json({ success: false, message: err.message });
  }
};

// =============================
// GET /api/profile-view/u/:username/cv
// PUBLIC — same behavior as streamProfileCv, keyed by username.
// =============================
export const streamProfileCvByUsername = async (req, res) => {
  try {
    const username = (req.params.username || "").toLowerCase().trim();

    const { data: profile, error } = await supabase
      .from("user_profiles")
      .select("cv_url, full_name")
      .eq("username", username)
      .single();

    if (error || !profile?.cv_url) {
      return res.status(404).json({ success: false, message: "No CV on file." });
    }

    const fileRes = await fetch(profile.cv_url);
    if (!fileRes.ok) {
      return res.status(502).json({ success: false, message: "Could not load CV file." });
    }

    const contentType = fileRes.headers.get("content-type") || "application/pdf";
    const buffer = Buffer.from(await fileRes.arrayBuffer());

    res.setHeader("Content-Type", contentType);
    res.setHeader("Content-Disposition", `inline; filename="cv.pdf"`);
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Cache-Control", "private, no-store");
    return res.send(buffer);
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
};