// utils/turnstile.js
// Server-side check that a Turnstile token from the browser is genuine.
// Needs TURNSTILE_SECRET_KEY in the backend environment.
export const verifyTurnstile = async (token, ip) => {
  if (!token || !process.env.TURNSTILE_SECRET_KEY) return false;

  const body = new URLSearchParams({
    secret:   process.env.TURNSTILE_SECRET_KEY,
    response: token,
  });
  if (ip) body.append("remoteip", ip);

  try {
    const r = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
      method: "POST",
      body,
    });
    const data = await r.json();
    return data.success === true;
  } catch (err) {
    console.error("Turnstile verify failed:", err.message);
    return false; // never block the click — it just won't be marked verified
  }
};