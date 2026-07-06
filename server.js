import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import cookieParser from "cookie-parser";
import jobRoutes from "./route/jobRoutes.js";
import analyticsRoutes from "./route/analyticsRoutes.js";
import companyRoutes from "./route/companyRoutes.js";
import aiRoutes from "./route/ai.js";

dotenv.config();

const app = express();

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
  methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
};


app.use(cors(corsOptions));
app.options("*", cors(corsOptions));

app.use(express.json());
app.use(cookieParser());

app.use("/api/ai", aiRoutes);
app.use("/api/jobs",      jobRoutes);
app.use("/api/analytics", analyticsRoutes);
app.use("/api/companies", companyRoutes);

app.get("/", (req, res) => {
  res.json({ success: true, message: "Job API is running 🚀" });
});

app.get("/health", (req, res) => {
  res.status(200).json({
    success:     true,
    status:      "healthy",
    uptime:      process.uptime(),
    timestamp:   new Date().toISOString(),
    environment: process.env.NODE_ENV || "development",
  });
});

app.use((req, res) => {
  res.status(404).json({ success: false, message: "Route not found" });
});

app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).json({ success: false, message: "Something went wrong" });
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));
