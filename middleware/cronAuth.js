// middleware/cronAuth.js
export function requireCronSecret(req, res, next) {
  const provided = req.headers["x-cron-secret"];
  if (!provided || provided !== process.env.CRON_SECRET) {
    return res.status(401).json({ success: false, message: "Invalid or missing cron secret" });
  }
  next();
}