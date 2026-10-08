import { v4 as uuidv4 } from "uuid";
import { supabase } from "../config/supabase.js";
import { trackJobClick, getAllClicks } from "../services/analytics.service.js";
import { isBot } from "../utils/botDetector.js";
import { verifyTurnstile } from "../utils/turnstile.js";
import { getVisitorGeo } from "../utils/geo.js";

const isProduction = process.env.NODE_ENV === "production";

const COOKIE_OPTS = {
  maxAge:   1000 * 60 * 60 * 24 * 365, // 1 year
  httpOnly: true,                       // client JS can't read/forge this
  sameSite: isProduction ? "none" : "lax",
  secure:   isProduction,
};

// geoip-lite returns Nigerian states as ISO 3166-2 codes (e.g. "LA"). This turns
// them into readable names. Unknown codes are shown as-is.
const NG_STATES = {
  AB: "Abia", AD: "Adamawa", AK: "Akwa Ibom", AN: "Anambra", BA: "Bauchi",
  BY: "Bayelsa", BE: "Benue", BO: "Borno", CR: "Cross River", DE: "Delta",
  EB: "Ebonyi", ED: "Edo", EK: "Ekiti", EN: "Enugu", FC: "Abuja (FCT)",
  GO: "Gombe", IM: "Imo", JI: "Jigawa", KD: "Kaduna", KN: "Kano",
  KT: "Katsina", KE: "Kebbi", KO: "Kogi", KW: "Kwara", LA: "Lagos",
  NA: "Nasarawa", NI: "Niger", OG: "Ogun", ON: "Ondo", OS: "Osun",
  OY: "Oyo", PL: "Plateau", RI: "Rivers", SO: "Sokoto", TA: "Taraba",
  YO: "Yobe", ZA: "Zamfara",
};
const stateName = (country, region) =>
  region ? (country === "NG" ? NG_STATES[region] || region : region) : null;

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

    // event_type distinguishes a page view from an apply-button click.
    // Defaults to "view" for safety if an older client ever omits it.
    const eventType = req.body.event_type === "apply_click" ? "apply_click" : "view";

    // user_agent and is_bot are derived from request headers ONLY — never from
    // req.body. Bots are still stored (so they can be audited) but flagged, and
    // getAllClicks() excludes them from the dashboard. A logged-in user is never
    // treated as a bot, even if their UA looks odd.
    const userAgent = req.headers["user-agent"] || null;

    // Visitor's approximate location, looked up from their IP (the IP itself
    // is never saved). This is where the VISITOR is — not the job's location.
    const geo = getVisitorGeo(req);
    const bot       = !userId && isBot(userAgent);

    // Turnstile: proof the browser is real. A signed "human_ok" cookie remembers
    // a passed check for 30 days (a Turnstile token only works once). Unverified
    // clicks are still saved — they just aren't marked human_verified.
    let humanVerified = !bot && req.signedCookies?.human_ok === "1";
    if (!bot && !humanVerified && req.body.cf_turnstile_token) {
      humanVerified = await verifyTurnstile(req.body.cf_turnstile_token, req.ip);
      if (humanVerified) {
        res.cookie("human_ok", "1", {
          ...COOKIE_OPTS,
          maxAge: 1000 * 60 * 60 * 24 * 30,
          signed: true,
        });
      }
    }

    const result = await trackJobClick({
      job_id:        req.body.job_id,
      job_title:     req.body.job_title,
      company:       req.body.company,
      role_category: req.body.role_category,
      location:      req.body.location,
      referrer:      req.body.referrer || "direct",
      visitor_id:    visitorId,
      user_id:       userId,
      event_type:    eventType,
      user_agent:    userAgent,
      is_bot:        bot,
      human_verified: humanVerified,
      ...geo,
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

    // Bots are excluded by default (see getAllClicks in analytics.service.js).
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

    // ── Per-job view vs apply-click counts (for the admin JobRow pills).
    // Unlike topJobs above, this is NOT deduped per visitor — every view
    // event and every apply_click event counts, since JobRow wants raw
    // totals, not unique-visitor totals.
    const jobCounts = {};
    clicks.forEach((c) => {
      if (!c.job_id) return;
      if (!jobCounts[c.job_id]) {
        jobCounts[c.job_id] = { view: 0, apply_click: 0 };
      }
      const type = c.event_type === "apply_click" ? "apply_click" : "view";
      jobCounts[c.job_id][type]++;
    });

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

    // ── Visitor locations: where the PEOPLE are (from IP), 1 count per
    // visitor. Different from topLocations above, which is where the JOBS are.
    // Every location people visited from, across ALL users. For each place:
    //   visitors = how many different people were there
    //   visits   = how many total clicks came from there
    // Returned two ways: by city (with its state + country) and by state.
    const cityMap  = {};
    const stateMap = {};
    const bump = (map, key, meta, c) => {
      if (!map[key]) map[key] = { ...meta, visits: 0, people: new Set() };
      map[key].visits++;
      if (c.visitor_id) map[key].people.add(c.visitor_id);
    };
    clicks.forEach((c) => {
      const country = c.visitor_country || "Unknown";
      const state   = stateName(c.visitor_country, c.visitor_region) || "Unknown";
      const city    = c.visitor_city || "Unknown";
      bump(cityMap,  `${country}|${state}|${city}`, { country, state, city }, c);
      bump(stateMap, `${country}|${state}`,         { country, state },       c);
    });
    const finalize = (map) =>
      Object.values(map)
        .map(({ people, ...rest }) => ({ ...rest, visitors: people.size }))
        .sort((a, b) => b.visitors - a.visitors || b.visits - a.visits);
    const visitorLocations = finalize(cityMap);
    const visitorStates    = finalize(stateMap);

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

    // ── Verified visitors: the most trustworthy tier.
    // A visitor counts as verified if ANY of their events shows real-person
    // proof: passed Cloudflare Turnstile, was logged in, or clicked Apply.
    // (Old rows have no human_verified flag, so they only qualify via the
    // logged-in / apply-click signals.)
    const verifiedSet = new Set();
    let verifiedClicks = 0;
    clicks.forEach((c) => {
      const proof = c.human_verified === true || !!c.user_id || c.event_type === "apply_click";
      if (proof) {
        verifiedClicks++;
        if (c.visitor_id) verifiedSet.add(c.visitor_id);
      }
    });
    const verifiedVisitors = verifiedSet.size;

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
        jobCounts,
        topLocations,
        topCategories,
        topReferrers,
        visitorLocations,
        visitorStates,
        clicksOverTime,
        returningUsers: returning,
        newUsers:       newVisitors,
        totalVisitors,
        verifiedVisitors,
        verifiedClicks,
        verifiedRate: totalVisitors > 0
          ? Math.round((verifiedVisitors / totalVisitors) * 100)
          : 0,
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