import { supabase } from "../config/supabase.js";

const adminCheck = async (req, res, next) => {
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

    const { data: { user }, error } = await supabase.auth.getUser(token);

    if (error || !user) {
      return res.status(401).json({
        success: false,
        message: "Invalid user",
      });
    }

    // GET PROFILE FROM DATABASE
    const { data: profile, error: profileError } = await supabase
      .from("profiles")
      .select("*")
      .eq("id", user.id)
      .single();

    if (profileError || !profile) {
      return res.status(403).json({
        success: false,
        message: "Profile not found",
      });
    }

    // CHECK ROLE IN DATABASE
    if (profile.role !== "admin") {
      return res.status(403).json({
        success: false,
        message: "Unauthorized - not admin",
      });
    }

    req.user = user;
    req.profile = profile;
    next();
  } catch (err) {
    return res.status(500).json({
      success: false,
      message: err.message,
    });
  }
};

export default adminCheck;