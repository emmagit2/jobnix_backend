// routes/recruiterHub.js
//
// Mount alongside your existing recruiter-view routes. No requireAuth —
// access is controlled by the Bearer access_token (email-scoped), same
// pattern as routes/recruiterViewMessages.js.

import express from "express";
import {
  requestHubCode,
  verifyHubCode,
  listHubJobs,
  listHubApplications,
  listHubConversations,
  getHubThread,
  replyHub,
  startHubConversation,
} from "../controllers/recruiterHub.controller.js";

const router = express.Router();

router.post("/recruiter-hub/request-code", requestHubCode);
router.post("/recruiter-hub/verify-code", verifyHubCode);
router.get("/recruiter-hub/jobs", listHubJobs);
router.get("/recruiter-hub/jobs/:jobId/applications", listHubApplications);
router.get("/recruiter-hub/conversations", listHubConversations);
router.get("/recruiter-hub/conversations/:conversationId/thread", getHubThread);
router.post("/recruiter-hub/conversations/:conversationId/reply", replyHub);
router.post("/recruiter-hub/conversations/start", startHubConversation);

export default router;