import express from 'express';
import requireAuth from '../middleware/requireAuth.js';
import { sendEmail } from '../lib/email.js';
import { onboardingEmail } from '../lib/emailTemplates.js';

const router = express.Router();

router.post('/onboarding', requireAuth, async (req, res) => {
  // 👇 add this line temporarily, right here
  console.log('[emails/onboarding] hit', req.body);

  const { accountType, name, orgName, status, ctaUrl } = req.body;
  const email = req.user.email;

  if (!email || !accountType) {
    return res.status(400).json({ success: false, message: 'Missing accountType.' });
  }

  try {
    const { subject, html } = onboardingEmail({ accountType, name, orgName, status, ctaUrl });
    await sendEmail({ to: email, subject, html });
    return res.status(200).json({ success: true });
  } catch (err) {
    console.error('[emails/onboarding] send failed:', err);
    return res.status(500).json({ success: false, message: err.message });
  }
});

export default router;