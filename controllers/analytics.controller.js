import { v4 as uuidv4 } from "uuid";
import { supabase } from "../config/supabase.js";
import { trackJobClick, getAllClicks } from "../services/analytics.service.js";

const isProduction = process.env.NODE_ENV === "production";

const COOKIE_OPTS = {
  maxAge:   1000 * 60 * 60 * 24 * 365, // 1 year
  httpOnly: true,                       // client JS can't read/forge this
  sameSite: isProduction ? "none" : "lax",
  secure:   isProduction,
};

// Click tracking is a PUBLIC route (no requireAuth middleware) — logged-out
// visitors must still be able to POST. So auth here is OPTIONAL: if a valid
// bearer token is present we resolve it to a user_id, otherwise we just
// proceed with user_id = null. This never blocks or errors the request.
const getOptionalUserId = async (req) => {
  const authHeader = req.headers.authorization; // "Bearer <token>"
  if (!authHeader?.startsWith("Bearer ")) return null;

  const token = authHeader.slice("Bearer ".length);
  const { data, error } = await supabase.auth.getUser(token);
  if (error || !data?.user) return null; // expired/invalid token → just anonymous

  return data.user.id;
};

// =============================
// POST /api/analytics/job-click
// =============================
export const jobClickController = async (req, res) => {
  try {
    // visitor_id comes ONLY from the httpOnly cookie. If missing, mint a new
    // one server-side and set it. A raw POST from curl/Postman with a fake
    // visitor_id in the body is ignored entirely — this field is never read
    // from req.body.
    let visitorId = req.cookies?.visitor_id;
    if (!visitorId) {
      visitorId = uuidv4();
      res.cookie("visitor_id", visitorId, COOKIE_OPTS);
    }

    // user_id is populated only if the visitor happens to be logged in and
    // sent a valid Supabase access token — otherwise it stays null.
    const userId = await getOptionalUserId(req);

    const result = await trackJobClick({
      job_id:        req.body.job_id,
      job_title:     req.body.job_title,
      company:       req.body.company,
      role_category: req.body.role_category,
      location:      req.body.location,
      referrer:      req.body.referrer || "direct",
      visitor_id:    visitorId,
      user_id:       userId,
    });

    return res.status(201).json({ success: true, data: result });
  } catch (err) {
    console.error("jobClickController error:", err);
    return res.status(500).json({ success: false, message: err.message });
  }
};

// =============================
// GET /api/analytics/clicks
// =============================
export const analyticsOverviewController = async (req, res) => {
  try {
    // Prevent any caching layer (browser, proxy, CDN) from serving a stale
    // 304 for this endpoint — analytics must always reflect live data.
    res.set("Cache-Control", "no-store");

    const clicks = await getAllClicks();

    // ── Top jobs (1 count per visitor per job — dedupe repeat clicks)
    const jobSeen = new Set();
    const jobMap  = {};
    clicks.forEach((c) => {
      const key = `${c.visitor_id}__${c.job_id}`;
      if (jobSeen.has(key)) return;
      jobSeen.add(key);
      if (!jobMap[c.job_id]) {
        jobMap[c.job_id] = { job_title: c.job_title, company: c.company, count: 0 };
      }
      jobMap[c.job_id].count++;
    });
    const topJobs = Object.values(jobMap).sort((a, b) => b.count - a.count);

    // ── Locations
    const locationMap = {};
    clicks.forEach((c) => {
      if (!c.location) return;
      const loc = c.location.trim();
      locationMap[loc] = (locationMap[loc] || 0) + 1;
    });
    const topLocations = Object.entries(locationMap)
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 8);

    // ── Categories
    const categoryMap = {};
    clicks.forEach((c) => {
      const cat = c.role_category || "Other";
      categoryMap[cat] = (categoryMap[cat] || 0) + 1;
    });
    const topCategories = Object.entries(categoryMap)
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 8);

    // ── Referrers
    const referrerMap = {};
    clicks.forEach((c) => {
      const ref = c.referrer || "direct";
      referrerMap[ref] = (referrerMap[ref] || 0) + 1;
    });
    const topReferrers = Object.entries(referrerMap)
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => b.count - a.count);

    // ── Visitors: unique + returning vs new
    // "Returning" = visitor_id seen on 2+ distinct calendar days (UTC).
    const visitorDays = {};
    clicks.forEach((c) => {
      if (!c.visitor_id) return;
      if (!visitorDays[c.visitor_id]) visitorDays[c.visitor_id] = new Set();
      visitorDays[c.visitor_id].add(c.created_at.slice(0, 10));
    });
    const totalVisitors = Object.keys(visitorDays).length;
    const returning     = Object.values(visitorDays).filter((d) => d.size > 1).length;
    const newVisitors   = totalVisitors - returning;

    // ── Clicks over time (last 14 days)
    const timeSeries = {};
    clicks.forEach((c) => {
      const day = c.created_at.slice(0, 10); // "YYYY-MM-DD"
      timeSeries[day] = (timeSeries[day] || 0) + 1;
    });
    const clicksOverTime = Array.from({ length: 14 }, (_, i) => {
      const date = new Date();
      date.setDate(date.getDate() - (13 - i));
      const yyyy = date.getFullYear();
      const mm   = String(date.getMonth() + 1).padStart(2, "0");
      const dd   = String(date.getDate()).padStart(2, "0");
      const key  = `${yyyy}-${mm}-${dd}`;
      return {
        day:   date.toLocaleDateString("en-US", { month: "short", day: "numeric" }),
        count: timeSeries[key] || 0,
      };
    });

    return res.json({
      success: true,
      data: {
        totalClicks: clicks.length,
        topJobs,
        topLocations,
        topCategories,
        topReferrers,
        clicksOverTime,
        returningUsers: returning,
        newUsers:       newVisitors,
        totalVisitors,
        returnRate: totalVisitors > 0
          ? Math.round((returning / totalVisitors) * 100)
          : 0,
      },
    });
  } catch (err) {
    console.error("analyticsOverviewController error:", err);
    return res.status(500).json({ success: false, message: err.message });
  }
};