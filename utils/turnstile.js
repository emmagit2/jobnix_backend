// server/utils/turnstile.js
const SITEVERIFY_URL = "https://challenges.cloudflare.com/turnstile/v0/siteverify";
const TIMEOUT_MS     = 10_000;

export const verifyTurnstile = async (token, ip = null) => {
  // ── Build hostname set here, not at module level ──────────────────────
  // dotenv hasn't run yet when this module first loads in an ES module
  // project — reading env vars inside the function guarantees they're set.
  const expectedHostnames = new Set(
    (process.env.TURNSTILE_HOSTNAMES ?? "")
      .split(",")
      .map((h) => h.trim())
      .filter(Boolean)
  );

  if (typeof token !== "string" || token.length === 0 || token.length > 2048) {
    return { ok: false, reason: "invalid_token" };
  }

  if (!process.env.TURNSTILE_SECRET) {
    console.error("verifyTurnstile: TURNSTILE_SECRET is not set");
    return { ok: false, reason: "misconfigured" };
  }

  if (expectedHostnames.size === 0) {
    console.error("verifyTurnstile: TURNSTILE_HOSTNAMES is not set");
    return { ok: false, reason: "misconfigured" };
  }

  const body = new URLSearchParams({
    secret:   process.env.TURNSTILE_SECRET,
    response: token,
  });
  if (ip) body.append("remoteip", ip);

  let data;
  try {
    const r = await fetch(SITEVERIFY_URL, {
      method:  "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });

    if (!r.ok) return { ok: false, reason: `siteverify_http_${r.status}` };

    data = await r.json();
  } catch (err) {
    const reason = err.name === "TimeoutError" ? "siteverify_timeout" : "siteverify_network";
    console.error(`verifyTurnstile: ${reason} —`, err.message);
    return { ok: false, reason };
  }

  if (!data.success) {
    const codes = data["error-codes"] ?? [];
    console.warn("verifyTurnstile: challenge failed", codes);
    return { ok: false, reason: `challenge_failed:${codes.join(",")}` };
  }

  if (!expectedHostnames.has(data.hostname)) {
    console.warn("verifyTurnstile: hostname mismatch", {
      expected: [...expectedHostnames],
      received: data.hostname,
    });
    return { ok: false, reason: "hostname_mismatch" };
  }

  const expectedAction = process.env.TURNSTILE_ACTION;
  if (expectedAction && data.action && data.action !== expectedAction) {
    console.warn("verifyTurnstile: action mismatch", {
      expected: expectedAction,
      received: data.action,
    });
    return { ok: false, reason: "action_mismatch" };
  }

  return { ok: true };
};