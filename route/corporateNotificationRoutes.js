// routes/corporateNotificationRoutes.js
import express from "express";
import requireAuth from "../middleware/RequireAuth.js";
import requireCorporateAccount from "../middleware/requireCorporateAccount.js"; // create this if it doesn't exist yet, mirroring requireBusinessAccount
import * as ctrl from "../controllers/corporateNotificationController.js";

const router = express.Router();

router.get("/", requireAuth, requireCorporateAccount, ctrl.listNotifications);
router.patch("/:id/read", requireAuth, requireCorporateAccount, ctrl.markAsRead);
router.patch("/read-all", requireAuth, requireCorporateAccount, ctrl.markAllAsRead);
router.delete("/:id", requireAuth, requireCorporateAccount, ctrl.deleteNotification);

export default router;

// In your main app file, mount this alongside the other two:
//   import corporateNotificationRoutes from "./routes/corporateNotificationRoutes.js";
//   app.use("/api/corporate/notifications", corporateNotificationRoutes);