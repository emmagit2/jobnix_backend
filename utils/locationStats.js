// utils/locationStats.js
// Builds the "where are my visitors" tables from the click rows.
// For every place:
//   visitors = how many DIFFERENT people came from there
//   visits   = how many total clicks came from there
// Nothing is capped, so every location appears.
import { getCountryName, getStateName } from "./geoNames.js";

const UNKNOWN = "Unknown";

const group = (clicks, keyOf, shapeOf) => {
  const map = new Map();
  clicks.forEach((c) => {
    const key = keyOf(c);
    if (!map.has(key)) map.set(key, { ...shapeOf(c), visits: 0, people: new Set() });
    const g = map.get(key);
    g.visits++;
    if (c.visitor_id) g.people.add(c.visitor_id);
  });
  return [...map.values()]
    .map(({ people, ...rest }) => ({ ...rest, visitors: people.size }))
    .sort((a, b) => b.visitors - a.visitors || b.visits - a.visits);
};

export const buildLocationStats = (clicks) => {
  const place = (c) => ({
    city:    c.visitor_city || UNKNOWN,
    state:   getStateName(c.visitor_country, c.visitor_region) || UNKNOWN,
    country: getCountryName(c.visitor_country) || UNKNOWN,
  });

  return {
    // every distinct place: city + state + country
    visitorLocations: group(
      clicks,
      (c) => { const p = place(c); return `${p.country}|${p.state}|${p.city}`; },
      place
    ),
    // rolled up by state
    visitorStates: group(
      clicks,
      (c) => { const p = place(c); return `${p.country}|${p.state}`; },
      (c) => { const p = place(c); return { state: p.state, country: p.country }; }
    ),
    // rolled up by country
    visitorCountries: group(
      clicks,
      (c) => place(c).country,
      (c) => ({ country: place(c).country })
    ),
  };
};