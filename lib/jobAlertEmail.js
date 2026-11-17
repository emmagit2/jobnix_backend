// lib/jobAlertEmail.js
//
// Builds the subject, HTML and plain-text body for a job alert email.
// Returns { subject, html, text }.
//
// Check JOB_URL: it must match how your site opens one job.

const SITE_URL = process.env.SITE_URL || "https://jobnix.ng";
const JOB_URL = (job) => `${SITE_URL}/jobs/${job.slug || job.id}`;
const SETTINGS_URL = `${SITE_URL}/settings`;

const esc = (s) =>
  String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

const money = (n, cur) =>
  new Intl.NumberFormat("en-NG", { maximumFractionDigits: 0 }).format(Number(n)) +
  (cur && cur !== "NGN" ? ` ${cur}` : "");

function payLine(job) {
  const cur = job.salary_currency || "NGN";
  const symbol = cur === "NGN" ? "₦" : "";
  if (job.salary_min && job.salary_max)
    return `${symbol}${money(job.salary_min, cur)} – ${symbol}${money(job.salary_max, cur)}`;
  if (job.salary_min) return `From ${symbol}${money(job.salary_min, cur)}`;
  if (job.pay_amount)
    return `${symbol}${money(job.pay_amount, cur)}${job.pay_type ? ` (${job.pay_type})` : ""}`;
  return "";
}

const fmtDate = (d) =>
  new Date(d).toLocaleDateString("en-NG", { day: "numeric", month: "short", year: "numeric" });

export function buildJobAlertEmail(user, matches, { urgent = false, totalMatches = matches.length } = {}) {
  const name = user.first_name || (user.full_name || "").split(" ")[0] || "there";
  const count = matches.length;
  const more = Math.max(0, totalMatches - count);

  const subject = urgent
    ? count === 1
      ? `Urgent job: ${matches[0].job.title}`
      : `${count} urgent jobs near you`
    : count === 1
      ? `New job for you: ${matches[0].job.title}`
      : `${count} new jobs for you`;

  const intro = urgent
    ? "These urgent jobs just came up in your chosen places:"
    : "Here are new jobs that match your settings:";

  const rows = matches
    .map(({ job, reasons }) => {
      const pay = payLine(job);
      const meta = [job.location, job.job_type, pay].filter(Boolean).map(esc).join(" · ");
      const why = (reasons || []).filter(Boolean).map(esc).join(" · ");
      return `
      <tr><td style="padding:14px 0;border-bottom:1px solid #E3E8EE">
        <a href="${JOB_URL(job)}" style="font-size:16px;font-weight:700;color:#1F5DA8;text-decoration:none">${esc(job.title)}</a>
        ${job.is_urgent ? '<span style="margin-left:8px;font-size:11px;font-weight:700;color:#B45309">URGENT</span>' : ""}
        <div style="margin-top:4px;font-size:13px;color:#5B6B7F">${meta}</div>
        ${job.deadline ? `<div style="margin-top:2px;font-size:12px;color:#5B6B7F">Apply by ${esc(fmtDate(job.deadline))}</div>` : ""}
        ${why ? `<div style="margin-top:2px;font-size:12px;color:#12805C">${why}</div>` : ""}
      </td></tr>`;
    })
    .join("");

  const html = `<!doctype html>
<html><body style="margin:0;background:#F4F6F8;font-family:Arial,Helvetica,sans-serif">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#F4F6F8;padding:24px 12px"><tr><td align="center">
    <table width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#fff;border-radius:12px;padding:24px">
      <tr><td>
        <div style="font-size:20px;font-weight:800;color:#0F1B2D">Hi ${esc(name)},</div>
        <p style="margin:8px 0 0;font-size:14px;color:#3E4D61">${intro}</p>
      </td></tr>
      ${rows}
      ${more > 0 ? `<tr><td style="padding-top:14px;font-size:13px;color:#5B6B7F">+ ${more} more matching ${more === 1 ? "job" : "jobs"} on <a href="${SITE_URL}/jobs" style="color:#1F5DA8">Jobnix</a>.</td></tr>` : ""}
      <tr><td style="padding-top:22px;font-size:12px;color:#7B8A9C">
        You get this because job alerts are on for your account.
        <a href="${SETTINGS_URL}" style="color:#1F5DA8">Change or turn off alerts</a>.
      </td></tr>
    </table>
  </td></tr></table>
</body></html>`;

  const textRows = matches
    .map(({ job }) => {
      const meta = [job.location, job.job_type, payLine(job)].filter(Boolean).join(" · ");
      return `- ${job.title}${meta ? ` (${meta})` : ""}\n  ${JOB_URL(job)}`;
    })
    .join("\n\n");

  const text =
    `Hi ${name},\n\n${intro}\n\n${textRows}\n` +
    (more > 0 ? `\n+ ${more} more matching jobs: ${SITE_URL}/jobs\n` : "") +
    `\nChange or turn off alerts: ${SETTINGS_URL}\n`;

  return {
    subject,
    html,
    text,
    headers: { "List-Unsubscribe": `<${SETTINGS_URL}>` },
  };
}