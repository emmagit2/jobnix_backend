import { v4 as uuidv4 } from "uuid";
import { trackJobClick, getAllClicks } from "../services/analytics.service.js";

const isProduction = process.env.NODE_ENV === "production";

const COOKIE_OPTS = {
  maxAge:   1000 * 60 * 60 * 24 * 365,
  httpOnly: true,
  sameSite: isProduction ? "none" : "lax",
  secure:   isProduction,
};

export const jobClickController = async (req, res) => {
  try {
    let visitorId = req.cookies?.visitor_id;
    if (!visitorId) {
      visitorId = uuidv4();
      res.cookie("visitor_id", visitorId, COOKIE_OPTS);
    }

    const result = await trackJobClick({
      job_id:        req.body.job_id,
      job_title:     req.body.job_title,
      company:       req.body.company,
      role_category: req.body.role_category,
      location:      req.body.location,
      referrer:      req.body.referrer || "direct",
      visitor_id:    visitorId,
    });

    return res.json({ success: true, data: result });
  } catch (err) {
    console.error("jobClickController error:", err);
    return res.status(500).json({ success: false, message: err.message });
  }
};

export const analyticsOverviewController = async (req, res) => {
  try {
    const clicks = await getAllClicks();

    // ── Top jobs (1 count per visitor per job)
    const jobSeen = new Set();
    const jobMap  = {};
    clicks.forEach((c) => {
      const key = `${c.visitor_id}__${c.job_id}`;
      if (jobSeen.has(key)) return;
      jobSeen.add(key);
      if (!jobMap[c.job_id])
        jobMap[c.job_id] = { job_title: c.job_title, company: c.company, count: 0 };
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
      .sort((a, b) => b.count - a.count);

    // ── Categories
    const categoryMap = {};
    clicks.forEach((c) => {
      if (!c.role_category) return;
      categoryMap[c.role_category] = (categoryMap[c.role_category] || 0) + 1;
    });
    const topCategories = Object.entries(categoryMap)
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => b.count - a.count);

    // ── Referrers
    const referrerMap = {};
    clicks.forEach((c) => {
      const ref = c.referrer || "direct";
      referrerMap[ref] = (referrerMap[ref] || 0) + 1;
    });
    const topReferrers = Object.entries(referrerMap)
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => b.count - a.count);

    // ── Returning visitors
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
        clicksOverTime,                // ← added
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