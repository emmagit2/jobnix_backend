// lib/jobAlertEmail.js
//
// Builds the subject, HTML and plain-text body for a job alert.

const SITE_URL = process.env.SITE_URL || "https://jobnix.ng";

const esc = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

const jobUrl = (job) => `${SITE_URL}/jobs/${job.slug || job.id}`;

const money = (n, cur = "NGN") =>
  `${cur === "NGN" ? "₦" : `${cur} `}${Number(n).toLocaleString("en-NG")}`;

function payLine(job) {
  if (job.pay_amount) return `${job.pay_amount}${job.pay_type ? ` (${job.pay_type.toLowerCase()})` : ""}`;
  if (job.salary_min && job.salary_max) return `${money(job.salary_min, job.salary_currency)} to ${money(job.salary_max, job.salary_currency)}`;
  if (job.salary_min) return `From ${money(job.salary_min, job.salary_currency)}`;
  if (job.salary_max) return `Up to ${money(job.salary_max, job.salary_currency)}`;
  return "";
}

function fmtDate(d) {
  return new Date(d).toLocaleDateString("en-NG", { day: "numeric", month: "short", timeZone: "Africa/Lagos" });
}

function details(job) {
  const parts = [job.location, job.job_type, payLine(job)].filter(Boolean);
  if (job.work_type === "informal" && job.starts_at) parts.push(`Starts ${fmtDate(job.starts_at)}`);
  else if (job.deadline) parts.push(`Apply by ${fmtDate(job.deadline)}`);
  return parts;
}

/**
 * @param user     user_profiles row
 * @param matches  [{ job, reasons }] best first
 * @param opts     { urgent, totalMatches }
 */
export function buildJobAlertEmail(user, matches, { urgent = false, totalMatches = matches.length } = {}) {
  const name = user.first_name || (user.full_name || "").split(" ")[0] || "there";
  const first = matches[0].job;
  const more = Math.max(0, totalMatches - matches.length);

  const subject = urgent
    ? `Urgent job: ${first.title}`
    : matches.length === 1
      ? `New job for you: ${first.title}`
      : `${matches.length} new jobs for you on Jobnix`;

  const intro = urgent
    ? "An urgent job was just posted in your area:"
    : matches.length === 1
      ? "A new job matches what you're looking for:"
      : "These new jobs match what you're looking for:";

  const cards = matches
    .map(({ job, reasons }) => {
      const meta = details(job).map(esc).join(" · ");
      const why = reasons?.length ? `<div style="margin-top:6px;font-size:12px;color:#12805C;font-weight:600">${esc(reasons.join(" · "))}</div>` : "";
      return `
      <tr><td style="padding:0 0 12px">
        <div style="border:1px solid #E3E8EE;border-radius:12px;padding:16px">
          <a href="${esc(jobUrl(job))}" style="font-size:16px;font-weight:700;color:#0F1B2D;text-decoration:none">${esc(job.title)}</a>
          ${meta ? `<div style="margin-top:6px;font-size:13px;color:#5B6B7F">${meta}</div>` : ""}
          ${why}
          <a href="${esc(jobUrl(job))}" style="display:inline-block;margin-top:12px;background:#1F5DA8;color:#fff;font-size:13px;font-weight:700;text-decoration:none;padding:9px 16px;border-radius:10px">View job</a>
        </div>
      </td></tr>`;
    })
    .join("");

  const html = `<!doctype html>
<html><body style="margin:0;background:#F4F6F8;font-family:Arial,Helvetica,sans-serif">
  <table width="100%" cellpadding="0" cellspacing="0" role="presentation"><tr><td align="center" style="padding:24px 12px">
    <table width="560" cellpadding="0" cellspacing="0" role="presentation" style="max-width:560px;width:100%;background:#fff;border-radius:16px;padding:24px">
      <tr><td style="padding-bottom:16px">
        <div style="font-size:20px;font-weight:800;color:#0F1B2D">Hi ${esc(name)},</div>
        <div style="margin-top:6px;font-size:14px;color:#5B6B7F">${intro}</div>
      </td></tr>
      ${cards}
      ${more > 0 ? `<tr><td style="padding:4px 0 12px;font-size:14px;color:#0F1B2D"><a href="${SITE_URL}/jobs" style="color:#1F5DA8;font-weight:700">See ${more} more ${more === 1 ? "match" : "matches"}</a></td></tr>` : ""}
      <tr><td style="border-top:1px solid #E3E8EE;padding-top:16px;font-size:12px;color:#7B8A9C;line-height:1.5">
        You get these because job alerts are on for your account.
        <a href="${SITE_URL}/settings" style="color:#1F5DA8">Change how often, or turn them off</a>.
      </td></tr>
    </table>
  </td></tr></table>
</body></html>`;

  const textJobs = matches
    .map(({ job }) => `${job.title}\n${details(job).join(" · ")}\n${jobUrl(job)}`)
    .join("\n\n");
  const text =
    `Hi ${name},\n\n${intro}\n\n${textJobs}\n` +
    (more > 0 ? `\nSee ${more} more: ${SITE_URL}/jobs\n` : "") +
    `\nChange or turn off alerts: ${SITE_URL}/settings\n`;

  return { subject, html, text, headers: { "List-Unsubscribe": `<${SITE_URL}/settings>` } };
}