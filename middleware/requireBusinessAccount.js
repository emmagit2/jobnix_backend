// middleware/requireBusinessAccount.js
// Chain AFTER your existing requireAuth, e.g.:
//   router.get("/api/jobs/mine", requireAuth, requireBusinessAccount, handler)
// requireAuth already verified the token and set req.userId — this just
// confirms that user also has a business_profiles row, and sets
// req.businessId (same value as req.userId; business_profiles.id === auth.users.id).
import { supabase } from "../config/supabase.js";

export default async function requireBusinessAccount(req, res, next) {
  const { data: business, error } = await supabase
    .from("business_profiles")
    .select("id")
    .eq("id", req.userId)
    .maybeSingle();
  if (error) return res.status(500).json({ success: false, message: error.message });
  if (!business) return res.status(403).json({ success: false, message: "This account is not a business account" });
  req.businessId = req.userId;
  next();
}