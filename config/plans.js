 // Central place to tweak what Free vs Premium unlocks — referenced by
// jobController (post limits) and accountController (dashboard display).
export const PLANS = {
  free: {
    label: "Free",
    maxActiveJobs: 1,
    jobPostingFeeKobo: 500000, // ₦5,000 per job on the free plan
    whatsappAiAssistant: true,
  },
  premium: {
    label: "Premium",
    maxActiveJobs: Infinity,
    jobPostingFeeKobo: 0, // included in subscription
    whatsappAiAssistant: true,
  },
};

export const PREMIUM_SUBSCRIPTION_FEE_KOBO = 2500000; // ₦25,000/month — adjust to your pricing
export const REFERRAL_REWARD_CREDITS = 1; // credits given to the referrer once the referred business pays