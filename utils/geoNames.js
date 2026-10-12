// utils/geoNames.js
// Turns the raw codes saved by geoip-lite (country "NG", region "LA") into
// readable names. Region codes for Nigeria are the standard two-letter state
// codes (ISO 3166-2:NG); these were checked against real Nigerian IP ranges.
// Outside Nigeria the raw region code is shown as-is.

const NG_STATES = {
  AB: "Abia", AD: "Adamawa", AK: "Akwa Ibom", AN: "Anambra", BA: "Bauchi",
  BE: "Benue", BO: "Borno", BY: "Bayelsa", CR: "Cross River", DE: "Delta",
  EB: "Ebonyi", ED: "Edo", EK: "Ekiti", EN: "Enugu", FC: "Abuja (FCT)",
  GO: "Gombe", IM: "Imo", JI: "Jigawa", KD: "Kaduna", KE: "Kebbi",
  KN: "Kano", KO: "Kogi", KT: "Katsina", KW: "Kwara", LA: "Lagos",
  NA: "Nasarawa", NI: "Niger", OG: "Ogun", ON: "Ondo", OS: "Osun",
  OY: "Oyo", PL: "Plateau", RI: "Rivers", SO: "Sokoto", TA: "Taraba",
  YO: "Yobe", ZA: "Zamfara",
};

let countryNames = null;
try {
  countryNames = new Intl.DisplayNames(["en"], { type: "region" });
} catch {
  countryNames = null;
}

export const getCountryName = (code) => {
  if (!code) return null;
  try {
    return countryNames?.of(code) || code;
  } catch {
    return code;
  }
};

export const getStateName = (country, region) => {
  if (!region) return null;
  if (country === "NG") return NG_STATES[region] || region;
  return region;
};