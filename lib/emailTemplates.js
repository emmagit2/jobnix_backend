// lib/emailTemplates.js
//
// Table-based layout with inline styles throughout — required for email
// clients (Gmail, Outlook, etc. strip <style> blocks and flexbox/grid
// support is unreliable). Keep it this way even though it's more verbose
// than normal HTML/CSS.
//
// Brand colors, matching the rest of the app:
//   navy   #0d3468  — headings, text accents
//   blue   #1f5da8  — links, secondary accents
//   orange #f26a21  — primary CTA buttons

const BRAND = {
  navy: "#0d3468",
  navyLight: "#1f5da8",
  orange: "#f26a21",
  orangeDark: "#e05a15",
  bg: "#f4f6f9",
  card: "#ffffff",
  text: "#1e293b",
  muted: "#64748b",
  border: "#e6e9ef",
  badgeBg: "#eef2f8",
};

const SITE_NAME = "Jobnix";
const SITE_URL = "https://jobnix.ng";
const SUBMIT_EMAIL = "submit@jobnix.ng";

// ✅ Hosted logo — override via EMAIL_LOGO_URL env var if it ever moves.
const LOGO_URL = process.env.EMAIL_LOGO_URL || "https://jobnix.ng/image/RENAMEPNG.png";
const LOGO_WIDTH = 132; // px — adjust to match your logo's aspect ratio
const TAGLINE = "One Profile. One Verification. Your privacy, in your hands.";

// Social links — footer row on every email
const SOCIAL = {
  instagram: "https://instagram.com/jobnixafrica",
  facebook: "https://facebook.com/jobnixafrica",
  x: "https://x.com/jobnixafrica",
  handle: "@jobnixafrica",
};

/* ─── Small circular social icon badge (table-based, email-safe) ───── */
const socialIcon = (url, glyph, label) => `
  <td style="padding:0 6px;">
    <a href="${url}" target="_blank" style="text-decoration:none;">
      <table role="presentation" cellpadding="0" cellspacing="0">
        <tr>
          <td width="34" height="34" align="center" valign="middle"
              style="background-color:${BRAND.card}; border:1px solid ${BRAND.border}; border-radius:10px; font-size:14px; color:${BRAND.navy}; font-weight:700;">
            ${glyph}
          </td>
        </tr>
      </table>
    </a>
  </td>
`;

/* ─── Shared shell every email is wrapped in ──────────────────────── */
const shell = ({ preheader, bodyHtml, unsubscribeUrl }) => `
<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>${SITE_NAME}</title>
  </head>
  <body style="margin:0; padding:0; background-color:${BRAND.bg}; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;">
    <!-- Preheader: hidden preview text shown in inbox lists -->
    <div style="display:none; max-height:0; overflow:hidden; opacity:0;">
      ${preheader}
    </div>

    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:${BRAND.bg}; padding:48px 16px;">
      <tr>
        <td align="center">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px; background-color:${BRAND.card}; border-radius:24px; overflow:hidden; border:1px solid ${BRAND.border}; box-shadow:0 1px 2px rgba(15,23,42,0.04), 0 12px 32px rgba(15,23,42,0.07);">

            <!-- Top accent bar -->
            <tr>
              <td style="height:4px; line-height:4px; font-size:0; background:linear-gradient(90deg, ${BRAND.navy} 0%, ${BRAND.navyLight} 55%, ${BRAND.orange} 100%);">&nbsp;</td>
            </tr>

            <!-- Header: white background, logo + tagline -->
            <tr>
              <td align="center" style="background-color:#ffffff; padding:44px 32px 28px;">
                <img src="${LOGO_URL}" alt="${SITE_NAME}" width="${LOGO_WIDTH}" style="display:block; height:auto; border:0; margin:0 auto 16px;" />
                <table role="presentation" cellpadding="0" cellspacing="0" style="margin:0 auto;">
                  <tr>
                    <td style="background-color:${BRAND.badgeBg}; border-radius:999px; padding:7px 16px;">
                      <p style="margin:0; font-size:11px; font-weight:700; color:${BRAND.navy}; letter-spacing:0.02em;">
                        ${TAGLINE}
                      </p>
                    </td>
                  </tr>
                </table>
              </td>
            </tr>

            <!-- Header/body divider -->
            <tr>
              <td style="padding:0 32px;">
                <div style="height:1px; background-color:${BRAND.border}; line-height:1px; font-size:0;">&nbsp;</div>
              </td>
            </tr>

            <!-- Body -->
            <tr>
              <td style="padding:38px 36px 8px;">
                ${bodyHtml}
              </td>
            </tr>

            <!-- Submit-a-job CTA strip -->
            <tr>
              <td style="padding:8px 32px 32px;">
                <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:${BRAND.bg}; border-radius:16px; border:1px solid ${BRAND.border};">
                  <tr>
                    <td style="padding:20px 22px;">
                      <table role="presentation" cellpadding="0" cellspacing="0">
                        <tr>
                          <td style="vertical-align:top; padding-right:12px;">
                            <table role="presentation" cellpadding="0" cellspacing="0">
                              <tr>
                                <td width="30" height="30" align="center" valign="middle" style="background-color:${BRAND.card}; border:1px solid ${BRAND.border}; border-radius:10px; font-size:14px;">
                                  &#9993;
                                </td>
                              </tr>
                            </table>
                          </td>
                          <td style="vertical-align:top;">
                            <p style="margin:0 0 3px; font-size:12.5px; font-weight:700; color:${BRAND.navy};">
                              Hiring for another role?
                            </p>
                            <p style="margin:0; font-size:12.5px; color:${BRAND.muted}; line-height:1.6;">
                              Post it on ${SITE_NAME} for free — email your job details to
                              <a href="mailto:${SUBMIT_EMAIL}" style="color:${BRAND.navyLight}; font-weight:700; text-decoration:none;">${SUBMIT_EMAIL}</a>
                              and our team will get it live.
                            </p>
                          </td>
                        </tr>
                      </table>
                    </td>
                  </tr>
                </table>
              </td>
            </tr>

            <!-- Footer -->
            <tr>
              <td align="center" style="padding:26px 32px 34px; border-top:1px solid ${BRAND.border};">

                <!-- Social row -->
                <table role="presentation" cellpadding="0" cellspacing="0" style="margin:0 auto 16px;">
                  <tr>
                    ${socialIcon(SOCIAL.instagram, "IG", "Instagram")}
                    ${socialIcon(SOCIAL.facebook, "FB", "Facebook")}
                    ${socialIcon(SOCIAL.x, "X", "X")}
                  </tr>
                </table>

                <p style="margin:0 0 6px; font-size:11.5px; font-weight:700; color:${BRAND.text}; letter-spacing:0.01em;">
                  ${SITE_NAME}
                </p>
                <p style="margin:0 0 10px; font-size:11.5px; color:${BRAND.muted}; line-height:1.6;">
                  <a href="${SITE_URL}" style="color:${BRAND.muted}; text-decoration:underline;">jobnix.ng</a>
                  &nbsp;&middot;&nbsp;
                  <a href="${SOCIAL.x}" style="color:${BRAND.muted}; text-decoration:underline;">${SOCIAL.handle}</a>
                </p>
                <p style="margin:0; font-size:11px; color:${BRAND.muted}; line-height:1.6;">
                  Didn't expect this email? You can safely ignore it.
                  ${unsubscribeUrl ? ` Or <a href="${unsubscribeUrl}" style="color:${BRAND.muted}; text-decoration:underline;">unsubscribe</a>.` : ""}
                </p>
              </td>
            </tr>

          </table>
        </td>
      </tr>
    </table>
  </body>
</html>
`;

/* ─── Reusable CTA button ──────────────────────────────────────────── */
const button = (url, label) => `
  <table role="presentation" cellpadding="0" cellspacing="0" style="margin:26px 0;">
    <tr>
      <td style="border-radius:14px; background-color:${BRAND.orange}; box-shadow:0 4px 10px rgba(242,106,33,0.28);">
        <a href="${url}" target="_blank"
          style="display:inline-block; padding:15px 34px; font-size:14px; font-weight:700; color:#ffffff; text-decoration:none; border-radius:14px;">
          ${label} &nbsp;&rarr;
        </a>
      </td>
    </tr>
  </table>
`;

/* =====================================================================
   RECRUITER LINK EMAIL
   Sent when the admin clicks "Email recruiter link" — gives the
   recruiter the link to their applicant dashboard for one job.
   ===================================================================== */
export const recruiterLinkEmail = ({ jobTitle, url, unsubscribeUrl }) => {
  const bodyHtml = `
    <p style="margin:0 0 6px; font-size:12px; font-weight:700; color:${BRAND.orange}; text-transform:uppercase; letter-spacing:0.06em;">
      Your applicant link
    </p>
    <h1 style="margin:0 0 16px; font-size:22px; font-weight:800; color:${BRAND.text}; line-height:1.35;">
      Applicants for "${jobTitle}"
    </h1>
    <p style="margin:0 0 4px; font-size:14px; color:${BRAND.text}; line-height:1.65;">
      You can view and track everyone who has applied to this role using the link below.
    </p>

    ${button(url, "View Applicants")}

    <table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="margin:6px 0 24px; background-color:${BRAND.bg}; border-radius:16px;">
      <tr>
        <td style="padding:18px 20px;">
          <table role="presentation" cellpadding="0" cellspacing="0">
            <tr>
              <td style="vertical-align:top; padding-right:12px;">
                <table role="presentation" cellpadding="0" cellspacing="0">
                  <tr>
                    <td width="28" height="28" align="center" valign="middle" style="background-color:${BRAND.card}; border:1px solid ${BRAND.border}; border-radius:10px; font-size:13px;">
                      &#9733;
                    </td>
                  </tr>
                </table>
              </td>
              <td style="vertical-align:top;">
                <p style="margin:0; font-size:13px; color:${BRAND.text}; line-height:1.65;">
                  The right hire changes everything for a team. Every profile you'll
                  see here has been through ${SITE_NAME}'s verification — so you're
                  spending your time meeting real, qualified talent, not sorting
                  through noise.
                </p>
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>

    <p style="margin:0 0 4px; font-size:13px; color:${BRAND.muted}; line-height:1.65;">
      For security, you'll be asked to verify a one-time code sent to this
      email address before the applicant list unlocks. The link itself
      doesn't expire, but each access code is only valid for 10 minutes.
    </p>

    <p style="margin:18px 0 0; font-size:12px; color:${BRAND.muted}; word-break:break-all;">
      Or copy this link: <a href="${url}" style="color:${BRAND.navyLight};">${url}</a>
    </p>
  `;

  return {
    subject: `Your applicants link for "${jobTitle}"`,
    html: shell({
      preheader: `View and track applicants for "${jobTitle}" on ${SITE_NAME}.`,
      bodyHtml,
      unsubscribeUrl,
    }),
  };
};

/* =====================================================================
   ACCESS CODE EMAIL
   Sent when the recruiter requests a code from the recruiter-view page.
   ===================================================================== */
export const recruiterAccessCodeEmail = ({ jobTitle, code, unsubscribeUrl }) => {
  const bodyHtml = `
    <p style="margin:0 0 6px; font-size:12px; font-weight:700; color:${BRAND.orange}; text-transform:uppercase; letter-spacing:0.06em;">
      Access code
    </p>
    <h1 style="margin:0 0 16px; font-size:22px; font-weight:800; color:${BRAND.text}; line-height:1.35;">
      Verify to view applicants for "${jobTitle}"
    </h1>
    <p style="margin:0 0 20px; font-size:14px; color:${BRAND.text}; line-height:1.65;">
      Enter this code on the page you came from to unlock the applicant list.
    </p>

    <table role="presentation" cellpadding="0" cellspacing="0" style="margin:0 0 24px;">
      <tr>
        <td style="background-color:${BRAND.bg}; border:1px solid ${BRAND.border}; border-radius:16px; padding:20px 36px;">
          <span style="font-size:32px; font-weight:800; letter-spacing:0.34em; color:${BRAND.navy};">
            ${code}
          </span>
        </td>
      </tr>
    </table>

    <p style="margin:0; font-size:13px; color:${BRAND.muted}; line-height:1.65;">
      This code expires in <strong>10 minutes</strong>. If you didn't request
      this, you can safely ignore this email — no one can access the
      applicant list without this code.
    </p>
  `;

  return {
    subject: `Your access code for "${jobTitle}" applicants`,
    html: shell({
      preheader: `Your access code is ${code}. It expires in 10 minutes.`,
      bodyHtml,
      unsubscribeUrl,
    }),
  };
};

export const recruiterHubAccessCodeEmail = ({ code, unsubscribeUrl }) => {
  const bodyHtml = `
    <p style="margin:0 0 6px; font-size:12px; font-weight:700; color:${BRAND.orange}; text-transform:uppercase; letter-spacing:0.06em;">
      Access code
    </p>
    <h1 style="margin:0 0 16px; font-size:22px; font-weight:800; color:${BRAND.text}; line-height:1.35;">
      Verify to open your recruiter dashboard
    </h1>
    <p style="margin:0 0 20px; font-size:14px; color:${BRAND.text}; line-height:1.65;">
      Enter this code where you requested it to unlock your dashboard.
    </p>

    <table role="presentation" cellpadding="0" cellspacing="0" style="margin:0 0 24px;">
      <tr>
        <td style="background-color:${BRAND.bg}; border:1px solid ${BRAND.border}; border-radius:16px; padding:20px 36px;">
          <span style="font-size:32px; font-weight:800; letter-spacing:0.34em; color:${BRAND.navy};">
            ${code}
          </span>
        </td>
      </tr>
    </table>

    <p style="margin:0; font-size:13px; color:${BRAND.muted}; line-height:1.65;">
      This code expires in <strong>10 minutes</strong>. If you didn't request
      this, you can safely ignore this email.
    </p>
  `;

  return {
    subject: "Your Jobnix recruiter dashboard code",
    html: shell({
      preheader: `Your access code is ${code}. It expires in 10 minutes.`,
      bodyHtml,
      unsubscribeUrl,
    }),
  };
};

/* =====================================================================
   APPLICATION CONFIRMATION EMAIL
   Sent to the applicant right after they successfully apply to a job.
   ===================================================================== */
export const applicationConfirmationEmail = ({ jobTitle, companyName, applicantName, jobUrl, unsubscribeUrl }) => {
  const bodyHtml = `
    <p style="margin:0 0 6px; font-size:12px; font-weight:700; color:${BRAND.orange}; text-transform:uppercase; letter-spacing:0.06em;">
      Application received
    </p>
    <h1 style="margin:0 0 16px; font-size:22px; font-weight:800; color:${BRAND.text}; line-height:1.35;">
      You applied to "${jobTitle}"${companyName ? ` at ${companyName}` : ""}
    </h1>
    <p style="margin:0 0 4px; font-size:14px; color:${BRAND.text}; line-height:1.65;">
      Hi ${applicantName || "there"}, we've let the employer know you're interested.
      They'll review your application and reach out directly if you're a good fit.
    </p>

    ${jobUrl ? button(jobUrl, "View Job Posting") : ""}

    <table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="margin:6px 0 24px; background-color:${BRAND.bg}; border-radius:16px;">
      <tr>
        <td style="padding:18px 20px;">
          <table role="presentation" cellpadding="0" cellspacing="0">
            <tr>
              <td style="vertical-align:top; padding-right:12px;">
                <table role="presentation" cellpadding="0" cellspacing="0">
                  <tr>
                    <td width="28" height="28" align="center" valign="middle" style="background-color:${BRAND.card}; border:1px solid ${BRAND.border}; border-radius:10px; font-size:13px;">
                      &#128188;
                    </td>
                  </tr>
                </table>
              </td>
              <td style="vertical-align:top;">
                <p style="margin:0; font-size:13px; color:${BRAND.text}; line-height:1.65;">
                  Want to see how your other applications are doing? Check your
                  dashboard on ${SITE_NAME} anytime to track their status.
                </p>
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>

    <p style="margin:0; font-size:13px; color:${BRAND.muted}; line-height:1.65;">
      Good luck! We're rooting for you.
    </p>
  `;

  return {
    subject: `You applied to "${jobTitle}"${companyName ? ` at ${companyName}` : ""} ✅`,
    html: shell({
      preheader: `Your application for "${jobTitle}" was received.`,
      bodyHtml,
      unsubscribeUrl,
    }),
  };
};

/* =====================================================================
   ONBOARDING / WELCOME EMAIL
   Sent right after a user's first onboarding completes.
   accountType: "jobseeker" | "business" | "corporate"
   status (corporate only): "active" | "pending"
   ===================================================================== */
export const onboardingEmail = ({ accountType, name, orgName, status, ctaUrl, unsubscribeUrl }) => {
  const isEmployer = accountType === "business";
  const isCorporate = accountType === "corporate";
  const isPending = isCorporate && status === "pending";

  let heading, bodyCopy, ctaLabel;

  if (isCorporate) {
    heading = isPending
      ? `Your request to join ${orgName} is in`
      : `Welcome to ${orgName} on ${SITE_NAME}`;
    bodyCopy = isPending
      ? `We've let an admin at ${orgName} know you're waiting. You'll get full workspace access as soon as they approve you — no further action needed from you.`
      : `Your workspace is ready. You can start reviewing candidates and collaborating with your team right away.`;
    ctaLabel = isPending ? "View Request Status" : "Go to Workspace";
  } else if (isEmployer) {
    heading = `Welcome to ${SITE_NAME}, let's find your next hire`;
    bodyCopy = `Your business account is ready. Post roles, message candidates, and review verified applicants — all in one place.`;
    ctaLabel = "Post Your First Job";
  } else {
    heading = `Welcome to ${SITE_NAME}, let's find your next role`;
    bodyCopy = `Your profile is ready. Browse open roles and apply in a couple of clicks — employers will reach out directly through ${SITE_NAME}.`;
    ctaLabel = "Browse Jobs";
  }

  const bodyHtml = `
    <p style="margin:0 0 6px; font-size:12px; font-weight:700; color:${BRAND.orange}; text-transform:uppercase; letter-spacing:0.06em;">
      ${isPending ? "Almost there" : "Welcome"}
    </p>
    <h1 style="margin:0 0 16px; font-size:22px; font-weight:800; color:${BRAND.text}; line-height:1.35;">
      ${heading}
    </h1>
    <p style="margin:0 0 4px; font-size:14px; color:${BRAND.text}; line-height:1.65;">
      Hi ${name || "there"}, ${isCorporate ? bodyCopy : `thanks for creating your ${isEmployer ? "business" : "job seeker"} account on ${SITE_NAME}. ${bodyCopy}`}
    </p>

    ${ctaUrl ? button(ctaUrl, ctaLabel) : ""}

    <p style="margin:0; font-size:13px; color:${BRAND.muted}; line-height:1.65;">
      Questions? Just reply to this email — we're happy to help.
    </p>
  `;

  return {
    subject: isCorporate
      ? (isPending ? `Your request to join ${orgName}` : `Welcome to ${orgName} on ${SITE_NAME}`)
      : isEmployer
        ? `Welcome to ${SITE_NAME} — let's find your next hire`
        : `Welcome to ${SITE_NAME} — let's find your next role`,
    html: shell({
      preheader: isPending ? `Your request to join ${orgName} is pending approval.` : `Your ${SITE_NAME} account is ready.`,
      bodyHtml,
      unsubscribeUrl,
    }),
  };
};