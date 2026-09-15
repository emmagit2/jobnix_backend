// lib/resendEmail.js
import { Resend } from 'resend';

const resend = new Resend(process.env.RESEND_API_KEY);

// Sent to a guest recruiter when the candidate replies — they have no
// in-app inbox to check, so the signed link is their only way back in.
export async function sendGuestReplyEmail({ to, guestName, messagePreview, replyUrl }) {
  try {
    await resend.emails.send({
      from: 'Jobnix <messages@jobnix.ng>',
      to,
      subject: 'New reply from a candidate on Jobnix',
      html: `
        <p>Hi ${guestName},</p>
        <p>You have a new message:</p>
        <blockquote>${messagePreview}</blockquote>
        <p><a href="${replyUrl}">View and reply</a></p>
      `,
    });
  } catch (err) {
    console.error('[resend] failed to send guest reply email', err);
  }
}

// Sent to the candidate (real account) when a guest recruiter messages
// them first, in case they're not actively checking the app.
export async function sendCandidateNewMessageEmail({ to, fromName, fromCompany, messagePreview, appUrl }) {
  try {
    await resend.emails.send({
      from: 'Jobnix <messages@jobnix.ng>',
      to,
      subject: `${fromName}${fromCompany ? ` from ${fromCompany}` : ''} sent you a message`,
      html: `
        <p>You have a new message on Jobnix:</p>
        <blockquote>${messagePreview}</blockquote>
        <p><a href="${appUrl}">View and reply</a></p>
      `,
    });
  } catch (err) {
    console.error('[resend] failed to send candidate new-message email', err);
  }
}