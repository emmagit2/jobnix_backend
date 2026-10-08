// utils/botDetector.js
// Flags obvious non-human traffic from the User-Agent header.
// This only catches "honest" bots (crawlers, link previewers, scripts, headless
// browsers). Sophisticated bots can fake a browser UA, so treat this as the
// first layer, not the last.

const BOT_PATTERN = new RegExp(
  [
    // Search engines & SEO crawlers
    "googlebot", "bingbot", "yandex", "baiduspider", "duckduckbot", "slurp",
    "ahrefsbot", "semrush", "mj12bot", "dotbot", "petalbot", "bytespider",
    // Link-preview fetchers (fire when someone shares a link on WhatsApp/FB/etc.)
    "facebookexternalhit", "facebot", "whatsapp", "telegrambot", "twitterbot",
    "linkedinbot", "slackbot", "discordbot", "skypeuripreview", "pinterest",
    // Uptime / monitoring
    "uptimerobot", "pingdom", "statuscake", "datadog", "newrelic",
    // Scripts, libraries, headless browsers
    "curl", "wget", "python-requests", "python-urllib", "axios", "node-fetch",
    "go-http-client", "java/", "okhttp", "postmanruntime", "insomnia",
    "headlesschrome", "phantomjs", "puppeteer", "playwright", "selenium", "lighthouse",
    // Generic
    "bot", "crawler", "spider", "scraper", "preview",
  ].join("|"),
  "i"
);

export const isBot = (userAgent) => {
  // A real browser always sends a User-Agent. Missing/very short = not a browser.
  if (!userAgent || userAgent.length < 10) return true;
  return BOT_PATTERN.test(userAgent);
};