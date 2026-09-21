process.on("unhandledRejection", (reason) => {
  console.error("UNHANDLED REJECTION — full detail:");
  console.error(reason);
});

import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import cookieParser from "cookie-parser";

// ── Existing production routes ─────────────────────────────────────────
import jobRoutes from "./route/jobRoutes.js";
import analyticsRoutes from "./route/analyticsRoutes.js";
import companyRoutes from "./route/companyRoutes.js";
import aiRoutes from "./route/ai.js";
import rolesRoutes from "./route/rolesRoutes.js";
import backfillUsersRouter from "./route/backfillUsers.js";
import applicationsRoutes from "./route/applications.routes.js";
import profileViewRoutes from "./route/profileViewRoutes.js";
import guestMessagesRoutes from "./route/guestMessages.js"; // public, no auth — guest recruiter messages a candidate
import syncUserRoutes from "./route/syncUser.js"; // mirrors users into messaging DB + claims guest history
import recruiterHubRoutes from "./route/recruiterHub.js"; // one dashboard — email sign-in, all jobs/applicants/messages
import userMessagesRoutes from "./route/userMessages.js";
import emailsRouter from "./route/emails.routes.js";
import { supabase } from "./config/supabase.js";

import whatsappRoutes from "./route/whatsapp.js";
import paymentRoutes from "./route/paymentRoutes.js";
import accountRoutes from "./route/accountRoutes.js";
import notificationRoutes from "./route/notificationRoutes.js";
import cronRoutes from "./route/cronRoutes.js";

dotenv.config();

const app = express();

// ── CORS ──────────────────────────────────────────────────────────────
const ALLOWED_ORIGINS = [
  "http://localhost:5173",
  "https://jobnix.ng",
  "https://www.jobnix.ng",
];
const corsOptions = {
  origin: (origin, callback) => {
    if (!origin || ALLOWED_ORIGINS.includes(origin)) callback(null, true);
    else callback(new Error("Not allowed by CORS"));
  },
  credentials: true,
  methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
};
app.use(cors(corsOptions));
app.options("*", cors(corsOptions));

// Capture the raw request body so WhatsApp/Paystack webhook signatures can
// be verified against the exact bytes Meta/Paystack sent — verifying
// against a re-serialized JSON object would fail. (Carried over from the
// old createApp() factory — needed for whatsappService.verifySignature.)
app.use(
  express.json({
    verify: (req, _res, buf) => {
      req.rawBody = buf;
    },
  })
);
app.use(cookieParser());

// ── Public guest messaging — MUST be mounted before "/api/messages" ─────
// userMessagesRoutes runs `router.use(requireAuth)`, so it rejects any
// unauthenticated request under /api/messages with a 401 before Express can
// reach a router mounted after it. guestMessagesRoutes defines its own full
// paths (/api/messages/guest-send, /api/messages/guest/:token, ...) and is
// deliberately public (guests have no login), so it has to be registered
// first or guest send/reply can never work.
app.use(guestMessagesRoutes);

// ── More specific mounts first ───────────────────────────────────────────
// Several routers below are mounted at the broad "/api" path rather than a
// specific sub-path. Express matches middleware strictly in registration
// order, and if one of those routers has its own catch-all fallback (e.g.
// `router.use((req, res) => res.status(404)...)`), it will swallow ANY
// unmatched "/api/*" request — including ones meant for routers mounted
// later, like paymentRoutes. Mounting the specific ones first guarantees
// they get first crack at matching before a broader router's fallback can
// intercept the request. This was the actual cause of
// /api/payments/informal-job/initialize 404ing even though paymentRoutes.js
// itself had the correct route defined.
app.use("/api/payments", paymentRoutes);
app.use("/api/whatsapp", whatsappRoutes);
app.use("/api/account", accountRoutes);
app.use("/api/notifications", notificationRoutes);
app.use("/api/cron", cronRoutes);
app.use("/api/ai", aiRoutes);
app.use("/api/jobs", jobRoutes);
app.use("/api/analytics", analyticsRoutes);
app.use("/api/companies", companyRoutes);
app.use("/api/roles", rolesRoutes);
app.use("/api/messages", userMessagesRoutes); // requireAuth on everything under here
app.use("/api/emails", emailsRouter);

// ── Existing production route mounts (broader "/api" paths — kept last so
// they can't shadow the more specific routers above) ─────────────────────
app.use(backfillUsersRouter);
app.use("/api", applicationsRoutes);
app.use("/api", profileViewRoutes);
app.use(syncUserRoutes);
app.use("/api", recruiterHubRoutes);

// ── Misc / health ─────────────────────────────────────────────────────
app.get("/", (req, res) => {
  res.json({ success: true, message: "Job API is running 🚀" });
});

app.get("/health", (req, res) => {
  res.status(200).json({
    success: true,
    status: "healthy",
    uptime: process.uptime(),
    timestamp: new Date().toISOString(),
    environment: process.env.NODE_ENV || "development",
  });
});

// ─── DB keep-alive ping — hits Supabase directly so both Render AND
// the Supabase connection pool stay warm. Point UptimeRobot here
// instead of (or in addition to) /health. ─────────────────────────
app.get("/api/ping-db", async (req, res) => {
  try {
    const { error } = await supabase.from("jobs").select("id").limit(1);
    if (error) throw error;
    res.status(200).json({ success: true, message: "DB connection warm" });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ── 404 + error handlers ─────────────────────────────────────────────
app.use((req, res) => {
  res.status(404).json({ success: false, message: "Route not found" });
});

app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).json({ success: false, message: "Something went wrong" });
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));

export default app;