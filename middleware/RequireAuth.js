import { supabase } from "../config/supabase.js";

// Same pattern as adminCheck.js, but only verifies the person is logged
// in — no role check. Use this for messaging routes, where any logged-in
// user (jobseeker, business, corporate) should be allowed through.
const requireAuth = async (req, res, next) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader) {
      return res.status(401).json({
        success: false,
        message: "No token provided",
      });
    }
    // Strip "Bearer " prefix if present
    const token = authHeader.startsWith("Bearer ")
      ? authHeader.slice(7)
      : authHeader;

    const {
      data: { user },
      error,
    } = await supabase.auth.getUser(token);
    if (error || !user) {
      return res.status(401).json({
        success: false,
        message: "Invalid user",
      });
    }

    req.user = user;
    req.userId = user.id;
    next();
  } catch (err) {
    return res.status(500).json({
      success: false,
      message: err.message,
    });
  }
};

export default requireAuth;