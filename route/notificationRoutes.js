// route/notificationRoutes.js
import express from "express";
import requireAuth from "../middleware/RequireAuth.js";
import requireBusinessAccount from "../middleware/requireBusinessAccount.js";
import * as ctrl from "../controllers/notificationController.js";

const router = express.Router();

// Preferences (existing)
router.get("/preferences", requireAuth, requireBusinessAccount, ctrl.getPreferences);
router.put("/preferences", requireAuth, requireBusinessAccount, ctrl.savePreferences);

// In-app feed (bell icon)
router.get("/", requireAuth, requireBusinessAccount, ctrl.listNotifications);
router.patch("/:id/read", requireAuth, requireBusinessAccount, ctrl.markAsRead);
router.patch("/read-all", requireAuth, requireBusinessAccount, ctrl.markAllAsRead);

// Push subscriptions
router.get("/push/vapid-public-key", ctrl.getVapidPublicKey);
router.post("/push/subscribe", requireAuth, requireBusinessAccount, ctrl.subscribePush);
router.post("/push/unsubscribe", requireAuth, requireBusinessAccount, ctrl.unsubscribePush);

export default router;