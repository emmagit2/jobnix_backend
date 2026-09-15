// lib/email.js
//
// Thin wrapper so controllers don't care which provider sends the email.
// Example below uses Resend — swap the fetch call for SendGrid/Postmark/
// whatever you actually have an API key for. Needs an env var either way
// (e.g. RESEND_API_KEY) — nothing will send until that's configured.
//
// FROM_ADDRESS includes a display name ("Jobnix Africa <...>") so inboxes
// show "Jobnix Africa" instead of falling back to showing the raw address
// (e.g. "no-reply@jobnix.ng") when no name is set. Override EMAIL_FROM if
// you ever want a different display name/address — keep the same
// "Name <email>" format or the display name will disappear again.
const FROM_ADDRESS = process.env.EMAIL_FROM || "Jobnix Africa <no-reply@jobnix.ng>";

export async function sendEmail({ to, subject, html }) {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    throw new Error("No email provider configured (RESEND_API_KEY missing) — cannot send this email.");
  }
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ from: FROM_ADDRESS, to, subject, html }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.message || "Failed to send email");
  }
  return res.json();
}