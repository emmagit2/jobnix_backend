// route/agentRoutes.js
import express from "express";
import { registerOrGetAgent, getAgentCommissions } from "../controllers/agentController.js";

const router = express.Router();

router.post("/register", registerOrGetAgent);
router.get("/:phone/commissions", getAgentCommissions);

export default router;