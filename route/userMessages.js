// routes/userMessages.js
//
// Logged-in inbox for ANY user type — jobseeker, business, corporate.
// Every route here requires a real Supabase session (Database 1),
// verified by requireAuth, which sets req.userId.
//
// This is separate from routes/recruiterViewMessages.js (the LINK + CODE
// guest flow, no login) and from routes/guestMessages.js (the public
// blind-send form on a candidate's profile page). All three ultimately
// read/write the SAME Database 2 tables (conversations/messages) — they
// just differ in how they figure out who's asking.
import express from "express";
import requireAuth from "../middleware/requireAuth.js";
import {
  listConversations,
  getThread,
  reply,
  startConversation,
} from "../controllers/userMessages.controller.js";

const router = express.Router();

router.use(requireAuth);

router.get("/conversations", listConversations);
router.get("/conversations/:conversationId", getThread);
router.post("/conversations/:conversationId/reply", reply);
router.post("/start", startConversation);

export default router;