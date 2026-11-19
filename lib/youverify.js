 // lib/youverify.js
export async function lookupNIN(nin) {
  // Read env vars inside the function, not at the top of the file.
  // ES module imports run before dotenv.config() in the server file,
  // so top-level reads would miss values from .env.
  const baseUrl = process.env.YOUVERIFY_BASE_URL || "https://api.youverify.co";
  const apiKey = process.env.YOUVERIFY_API_KEY;

  if (!apiKey) {
    const err = new Error("YOUVERIFY_API_KEY is not set.");
    err.upstreamStatus = 500;
    throw err;
  }

  const res = await fetch(`${baseUrl}/v2/api/identity/ng/nin`, {
    method: "POST",
    headers: { "Content-Type": "application/json", token: apiKey },
    body: JSON.stringify({ id: nin, isSubjectConsent: true }),
  });

  const body = await res.json().catch(() => null);

  if (!res.ok || !body?.success) {
    console.error("Youverify NIN error:", res.status, body?.message);
    const err = new Error(body?.message || "NIN verification failed");
    err.upstreamStatus = res.status;
    throw err;
  }

  return body.data;
}