import crypto from "crypto";

const PAYSTACK_SECRET_KEY = process.env.PAYSTACK_SECRET_KEY;
const PAYSTACK_BASE_URL = "https://api.paystack.co";
const CALLBACK_URL = `${process.env.API_BASE_URL || "http://localhost:5000"}/api/payments/callback`;

if (!PAYSTACK_SECRET_KEY) {
  // Fail loudly at startup rather than later with a cryptic 401 from
  // Paystack's API the first time someone tries to pay.
  console.warn("⚠️  PAYSTACK_SECRET_KEY is not set — payment endpoints will fail.");
}

// ─── Start a transaction — returns { authorization_url, access_code, reference } ─
export async function initializeTransaction({ email, amountKobo, reference, metadata }) {
  const res = await fetch(`${PAYSTACK_BASE_URL}/transaction/initialize`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${PAYSTACK_SECRET_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      email,
      amount: amountKobo, // Paystack expects the smallest currency unit (kobo for NGN)
      reference,
      metadata,
      callback_url: CALLBACK_URL,
    }),
  });

  const json = await res.json();
  if (!res.ok || !json.status) {
    throw new Error(json.message || "Failed to initialize Paystack transaction");
  }
  return json.data; // { authorization_url, access_code, reference }
}

// ─── Verify a transaction server-to-server — the only thing that should ────
// ever be trusted to say a payment actually succeeded (never the client
// callback alone, never the raw webhook payload alone).
export async function verifyTransaction(reference) {
  const res = await fetch(`${PAYSTACK_BASE_URL}/transaction/verify/${encodeURIComponent(reference)}`, {
    headers: { Authorization: `Bearer ${PAYSTACK_SECRET_KEY}` },
  });

  const json = await res.json();
  if (!res.ok || !json.status) {
    throw new Error(json.message || "Failed to verify Paystack transaction");
  }
  return json.data; // { status: "success" | "failed" | ..., amount, currency, reference, metadata, ... }
}

// ─── Verify the webhook signature against the RAW request body ─────────────
// Must be called with the untouched Buffer Paystack sent (see app.js's
// express.json({ verify: ... }) capturing req.rawBody) — re-serializing the
// parsed JSON object and hashing that will not match.
export function verifyWebhookSignature(rawBody, signature) {
  if (!rawBody || !signature) return false;
  const hash = crypto.createHmac("sha512", PAYSTACK_SECRET_KEY).update(rawBody).digest("hex");
  return hash === signature;
}