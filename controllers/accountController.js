// controllers/accountController.js
import * as businessProfilesRepo from "../lib/businessProfilesRepo.js";
import { PLANS } from "../config/plans.js";

// GET /api/account — powers the "Account" card (Plan, Member since, Delete account)
// No login endpoint here: your frontend already authenticates via Supabase Auth
// (Google OAuth etc.) and this backend just verifies that same session token.
export const getAccount = async (req, res) => {
  try {
    const business = await businessProfilesRepo.findById(req.businessId);
    if (!business) return res.status(404).json({ success: false, message: "Account not found" });
    await businessProfilesRepo.ensureReferralCode(business.id);

    res.json({
      success: true,
      data: {
        id: business.id,
        email: business.profiles?.email,
        businessName: business.business_name,
        plan: business.plan,
        planLabel: (PLANS[business.plan] || PLANS.free).label,
        memberSince: business.profiles?.created_at,
        phone: business.phone,
        phoneVerified: business.phone_verified,
        referralCode: business.referral_code,
      },
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// DELETE /api/account
export const deleteAccount = async (req, res) => {
  try {
    await businessProfilesRepo.remove(req.businessId);
    res.json({ success: true, deleted: true });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// GET /api/account/referrals — powers the "Refer & Earn" card
export const getReferralStats = async (req, res) => {
  try {
    const stats = await businessProfilesRepo.getReferralStats(req.businessId);
    res.json({ success: true, data: stats });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// POST /api/account/apply-referral — call once, e.g. right after first login,
// with a referral code the business was given (?ref=CODE in a shared link)
export const applyReferral = async (req, res) => {
  try {
    const { referralCode } = req.body;
    if (!referralCode) return res.status(400).json({ success: false, message: "referralCode is required" });
    await businessProfilesRepo.applyReferralCode(req.businessId, referralCode);
    res.json({ success: true, applied: true });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};