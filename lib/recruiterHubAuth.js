// lib/recruiterHubAuth.js
//
// Access tokens for the RECRUITER HUB dashboard — scoped to an email, not
// a job token. Used by BOTH entry points now:
//   - controllers/recruiterHub.controller.js  (sign in with just an email)
//   - controllers/applications.controller.js  (verifyRecruiterCode, the
//     old /recruiter-view/:token flow, now also mints one of these so it
//     can hand the recruiter into the same hub instead of its own view)
//
// kind: "recruiter-hub" keeps a hub token from being replayed against the
// /recruiter-view/:token routes, whose own verifyAccessToken() requires
// payload.token to match the URL param (a hub token has none).

import jwt from "jsonwebtoken";

const HUB_TOKEN_TTL = "1h"; // matches the existing per-job access_token TTL

export function signHubAccessToken(email) {
  return jwt.sign(
    { email: email.trim().toLowerCase(), kind: "recruiter-hub" },
    process.env.RECRUITER_JWT_SECRET,
    { expiresIn: HUB_TOKEN_TTL }
  );
}

export function verifyHubAccessToken(req) {
  const authHeader = req.headers.authorization || "";
  const bearer = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null;
  if (!bearer) return null;
  try {
    const payload = jwt.verify(bearer, process.env.RECRUITER_JWT_SECRET);
    if (payload.kind !== "recruiter-hub" || !payload.email) return null;
    return payload;
  } catch {
    return null;
  }
}