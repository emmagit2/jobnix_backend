import { trackJobClick, getAllClicks } from "../services/analytics.service.js";


// 👉 Track click
export const jobClickController = async (req, res) => {
  try {
    // 🔥 DEBUG START
    console.log("=== JOB CLICK DEBUG ===");
    console.log("BODY:", req.body);
    console.log("COOKIES:", req.cookies);
    console.log("USER ID (middleware):", req.userId);
    console.log("COOKIE USER ID:", req.cookies?.user_id);
    // 🔥 DEBUG END

    const userId = req.userId || req.cookies?.user_id;

    console.log("FINAL USER ID USED:", userId);

  const result = await trackJobClick({
  job_id: req.body.job_id,
  job_title: req.body.job_title,
  company: req.body.company,
  role_category: req.body.role_category,
  location: req.body.location,
  user_id: req.userId, // 🔥 ONLY THIS
});

    return res.json(result);
  } catch (err) {
    console.log("🔥 ERROR:", err);
    return res.status(500).json({ error: err.message });
  }
};

// 👉 Get analytics data
export const analyticsOverviewController = async (req, res) => {
  try {
    const clicks = await getAllClicks();

    // 🔥 TOP JOBS
    const jobMap = {};
    clicks.forEach((c) => {
      if (!jobMap[c.job_id]) {
        jobMap[c.job_id] = {
          job_title: c.job_title,
          company: c.company,
          count: 0,
        };
      }
      jobMap[c.job_id].count++;
    });

    const topJobs = Object.values(jobMap).sort(
      (a, b) => b.count - a.count
    );

    // 🌍 LOCATIONS
    const locationMap = {};
    clicks.forEach((c) => {
      if (!c.location) return;
      locationMap[c.location] =
        (locationMap[c.location] || 0) + 1;
    });

    const topLocations = Object.entries(locationMap).map(
      ([name, count]) => ({ name, count })
    );

    // 📂 CATEGORIES
    const categoryMap = {};
    clicks.forEach((c) => {
      if (!c.role_category) return;
      categoryMap[c.role_category] =
        (categoryMap[c.role_category] || 0) + 1;
    });

    const topCategories = Object.entries(categoryMap).map(
      ([name, count]) => ({ name, count })
    );

    // 👥 RETURNING USERS (COOKIE BASED)
    const userMap = {};
    clicks.forEach((c) => {
      if (!userMap[c.user_id]) userMap[c.user_id] = 0;
      userMap[c.user_id]++;
    });

    const users = Object.values(userMap);
    const returning = users.filter((u) => u > 1).length;
    const newUsers = users.length - returning;

    return res.json({
      totalClicks: clicks.length,
      topJobs,
      topLocations,
      topCategories,
      returningUsers: returning,
      newUsers,
      returnRate:
        users.length > 0
          ? Math.round((returning / users.length) * 100)
          : 0,
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
};