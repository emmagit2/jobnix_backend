// routes/seekerNotificationRoutes.js
import express from "express";
import requireAuth from "../middleware/RequireAuth.js";
import * as ctrl from "../controllers/seekerNotificationController.js";

const router = express.Router();

// No requireBusinessAccount here — any authenticated job seeker can use these.
router.get("/", requireAuth, ctrl.listNotifications);
router.patch("/:id/read", requireAuth, ctrl.markAsRead);
router.patch("/read-all", requireAuth, ctrl.markAllAsRead);
router.delete("/:id", requireAuth, ctrl.deleteNotification);

export default router;

// In your main app file, mount this alongside the business routes, e.g.:
//   import seekerNotificationRoutes from "./routes/seekerNotificationRoutes.js";
//   app.use("/api/seeker/notifications", seekerNotificationRoutes);