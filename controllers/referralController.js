// controllers/referralController.js
import { supabase } from "../config/supabase.js";

// GET /api/referrals/my-code
// Returns the authenticated business's referral code, generating one
// on first request if they don't have one yet.
export async function getMyReferralCode(req, res) {
  try {
    const businessId = req.userId; // set by requireAuth; business_profiles.id === profiles.id === auth user id

    let { data: business, error } = await supabase
      .from("business_profiles")
      .select("id, business_name, referral_code")
      .eq("id", businessId)
      .single();

    if (error || !business) {
      return res.status(404).json({ success: false, message: "Business profile not found" });
    }

    if (!business.referral_code) {
      const { data: code, error: codeErr } = await supabase.rpc("generate_referral_code", {
        p_business_name: business.business_name,
      });
      if (codeErr) throw codeErr;

      const { data: updated, error: updateErr } = await supabase
        .from("business_profiles")
        .update({ referral_code: code })
        .eq("id", businessId)
        .select("referral_code")
        .single();
      if (updateErr) throw updateErr;

      business.referral_code = updated.referral_code;
    }

    res.json({
      success: true,
      referral_code: business.referral_code,
      referral_link: `jobnix.com/r/${business.referral_code}`,
    });
  } catch (err) {
    console.error("getMyReferralCode error:", err);
    res.status(500).json({ success: false, message: "Failed to get referral code" });
  }
}

// GET /api/referrals/stats
// Returns the stats + referral list for the "Refer & Earn" page.
export async function getReferralStats(req, res) {
  try {
    const businessId = req.userId;

    const { data: referredBusinesses, error: refErr } = await supabase
      .from("business_profiles")
      .select("id, business_name, referred_at")
      .eq("referred_by_business_id", businessId)
      .order("referred_at", { ascending: false });
    if (refErr) throw refErr;

    const { data: earnings, error: earnErr } = await supabase
      .from("referral_earnings")
      .select("id, referred_business_id, commission_amount, currency, status, created_at")
      .eq("referrer_business_id", businessId);
    if (earnErr) throw earnErr;

    const totalEarned = earnings.reduce((sum, e) => sum + Number(e.commission_amount), 0);

    const now = new Date();
    const activeThisMonth = new Set(
      earnings
        .filter((e) => {
          const d = new Date(e.created_at);
          return d.getMonth() === now.getMonth() && d.getFullYear() === now.getFullYear();
        })
        .map((e) => e.referred_business_id)
    ).size;

    const referrals = referredBusinesses.map((b) => {
      const bEarnings = earnings.filter((e) => e.referred_business_id === b.id);
      const earned = bEarnings.reduce((sum, e) => sum + Number(e.commission_amount), 0);
      return {
        id: b.id,
        name: b.business_name,
        date: b.referred_at,
        status: bEarnings.length > 0 ? "Active" : "Pending",
        earned,
      };
    });

    res.json({
      success: true,
      stats: {
        businesses_referred: referredBusinesses.length,
        total_earned: totalEarned,
        active_this_month: activeThisMonth,
      },
      referrals,
    });
  } catch (err) {
    console.error("getReferralStats error:", err);
    res.status(500).json({ success: false, message: "Failed to get referral stats" });
  }
}

// POST /api/referrals/signup  { referral_code, business_id }
// Called during/after a new business's signup flow if they arrived via
// jobnix.com/r/CODE, to link them to whoever referred them.
export async function attachReferral(req, res) {
  try {
    const { referral_code, business_id } = req.body;
    if (!referral_code || !business_id) {
      return res.status(400).json({ success: false, message: "referral_code and business_id are required" });
    }

    const { data: referrer, error: refErr } = await supabase
      .from("business_profiles")
      .select("id")
      .eq("referral_code", referral_code)
      .single();

    if (refErr || !referrer) {
      return res.status(404).json({ success: false, message: "Invalid referral code" });
    }

    if (referrer.id === business_id) {
      return res.status(400).json({ success: false, message: "Cannot refer yourself" });
    }

    const { error: updateErr } = await supabase
      .from("business_profiles")
      .update({ referred_by_business_id: referrer.id, referred_at: new Date().toISOString() })
      .eq("id", business_id)
      .is("referred_by_business_id", null); // never overwrite an existing referral
    if (updateErr) throw updateErr;

    res.json({ success: true });
  } catch (err) {
    console.error("attachReferral error:", err);
    res.status(500).json({ success: false, message: "Failed to attach referral" });
  }
}