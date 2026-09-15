import express from "express";
import requireAuth from "../middleware/requireAuth.js";
import requireBusinessAccount from "../middleware/requireBusinessAccount.js";
import * as ctrl from "../controllers/notificationController.js";

const router = express.Router();

router.get("/preferences", requireAuth, requireBusinessAccount, ctrl.getPreferences);
router.put("/preferences", requireAuth, requireBusinessAccount, ctrl.savePreferences);

export default router;