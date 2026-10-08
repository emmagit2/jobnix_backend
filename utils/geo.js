// utils/geo.js
// Estimates a visitor's country / region / city from their IP address.
// The raw IP is used only for the lookup and is NEVER stored.
// Country is reliable; city is a rough estimate (Nigerian mobile networks often
// route traffic through Lagos).
import geoip from "geoip-lite";

export const getVisitorGeo = (req) => {
  const raw = req.headers["x-forwarded-for"]?.split(",")[0] || req.ip || "";
  const ip  = raw.trim().replace("::ffff:", "");
  const g   = geoip.lookup(ip);
  return {
    visitor_country: g?.country || null,
    visitor_region:  g?.region  || null,
    visitor_city:    g?.city    || null,
  };
};