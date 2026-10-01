// controllers/accountController.js
import * as businessProfilesRepo from "../lib/businessProfilesRepo.js";
import { PLANS } from "../config/plans.js";
import { supabase } from "../config/supabase.js";
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


// ═══════════════════════════════════════════════════════════════════════════
// ACCOUNT SWITCHING (job seeker ↔ business)
// ═══════════════════════════════════════════════════════════════════════════
const SWITCH_TYPES = ["jobseeker", "business"];
const uid = (req) => req.userId || req.user?.id;

// GET /api/accounts/me → which accounts I own + which one is active
export const getMyAccounts = async (req, res) => {
  try {
    const id = uid(req);
    const [prof, owned] = await Promise.all([
      supabase.from("profiles").select("account_type").eq("id", id).maybeSingle(),
      supabase.from("user_accounts").select("account_type, onboarded").eq("user_id", id),
    ]);
    if (prof.error) throw prof.error;
    if (owned.error) throw owned.error;

    res.json({
      success: true,
      data: {
        active: prof.data?.account_type || null,
        accounts: (owned.data || []).filter((r) => r.onboarded).map((r) => r.account_type),
      },
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// POST /api/accounts/switch { accountType }
export const switchAccount = async (req, res) => {
  try {
    const id = uid(req);
    const { accountType } = req.body;
    if (!SWITCH_TYPES.includes(accountType)) {
      return res.status(400).json({ success: false, message: "You can only switch between job seeker and business." });
    }

    const { data: prof } = await supabase.from("profiles").select("account_type").eq("id", id).maybeSingle();
    if (prof?.account_type === "corporate") {
      return res.status(403).json({ success: false, message: "Corporate accounts can't be switched." });
    }

    const { data: owned, error } = await supabase
      .from("user_accounts").select("account_type, onboarded")
      .eq("user_id", id).eq("account_type", accountType).maybeSingle();
    if (error) throw error;

    if (!owned || !owned.onboarded) {
      return res.status(403).json({
        success: false, code: "NEEDS_ONBOARDING", accountType,
        message: `Set up your ${accountType === "business" ? "business" : "job seeker"} account first.`,
      });
    }

    const { error: updErr } = await supabase
      .from("profiles").update({ account_type: accountType }).eq("id", id);
    if (updErr) throw updErr;

    res.json({ success: true, data: { active: accountType } });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// Call this from onboarding when a user finishes setting up an account type
export const registerAccount = async (userId, accountType) => {
  const { error } = await supabase
    .from("user_accounts")
    .upsert({ user_id: userId, account_type: accountType, onboarded: true }, { onConflict: "user_id,account_type" });
  if (error) throw new Error(error.message);
};