import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import cookieParser from "cookie-parser";

import jobRoutes from "./route/jobRoutes.js";
import analyticsRoutes from "./route/analyticsRoutes.js";

dotenv.config();

const app = express();


// =============================
// MIDDLEWARE
// =============================

// 🔥 CORS FIX (IMPORTANT FOR COOKIES)
app.use(cors({
  origin: [
    "http://localhost:5173",
    "https://jobnix.ng",
    "https://www.jobnix.ng"
  ],
  credentials: true,
  methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
}));

app.use(express.json());
app.use(cookieParser());


// =============================
// API ROUTES
// =============================
app.use("/api/jobs", jobRoutes);
app.use("/api/analytics", analyticsRoutes);


// =============================
// TEST ROUTE
// =============================
app.get("/", (req, res) => {
  res.json({
    success: true,
    message: "Job API is running 🚀",
  });
});


// =============================
// 404 HANDLER
// =============================
app.use((req, res) => {
  res.status(404).json({
    success: false,
    message: "Route not found",
  });
});


// =============================
// GLOBAL ERROR HANDLER
// =============================
app.use((err, req, res, next) => {
  console.error(err.stack);

  res.status(500).json({
    success: false,
    message: "Something went wrong",
  });
});


// =============================
// START SERVER
// =============================
const PORT = process.env.PORT || 5000;

app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});