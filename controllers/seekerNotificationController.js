// controllers/seekerNotificationController.js
//
// Mirrors controllers/notificationController.js but scopes every query to
// the logged-in job seeker instead of a business.
//
// ASSUMPTION: requireAuth attaches the seeker's id as req.user.id.
// If your middleware sets something else (req.userId, req.auth.sub, etc.)
// update the `seekerId` line below — everything else stays the same.
//
// Expects a `seeker_notifications` table shaped like `notifications` but
// with a `user_id` column instead of `business_id`:
//   id, user_id, type, title, body, link, metadata, is_read, created_at

import { supabase } from "../config/supabase.js";

function getSeekerId(req) {
  return req.user?.id ?? req.userId; // adjust to match your auth middleware
}

// GET /api/seeker/notifications?limit=20&before=<created_at>
export async function listNotifications(req, res) {
  try {
    const seekerId = getSeekerId(req);
    const limit = Math.min(Number(req.query.limit) || 20, 50);

    let query = supabase
      .from("seeker_notifications")
      .select("id, type, title, body, link, metadata, is_read, created_at")
      .eq("user_id", seekerId)
      .order("created_at", { ascending: false })
      .limit(limit);

    if (req.query.before) {
      query = query.lt("created_at", req.query.before);
    }

    const { data, error } = await query;
    if (error) throw error;

    const { count, error: countErr } = await supabase
      .from("seeker_notifications")
      .select("id", { count: "exact", head: true })
      .eq("user_id", seekerId)
      .eq("is_read", false);
    if (countErr) throw countErr;

    res.json({ success: true, notifications: data, unread_count: count || 0 });
  } catch (err) {
    console.error("[/api/seeker/notifications GET] error:", err);
    res.status(500).json({ success: false, message: err.message || "Something went wrong." });
  }
}

// PATCH /api/seeker/notifications/:id/read
export async function markAsRead(req, res) {
  try {
    const { error } = await supabase
      .from("seeker_notifications")
      .update({ is_read: true })
      .eq("id", req.params.id)
      .eq("user_id", getSeekerId(req)); // can't mark someone else's notification read
    if (error) throw error;

    res.json({ success: true });
  } catch (err) {
    console.error("[/api/seeker/notifications/:id/read PATCH] error:", err);
    res.status(500).json({ success: false, message: err.message || "Something went wrong." });
  }
}

// PATCH /api/seeker/notifications/read-all
export async function markAllAsRead(req, res) {
  try {
    const { error } = await supabase
      .from("seeker_notifications")
      .update({ is_read: true })
      .eq("user_id", getSeekerId(req))
      .eq("is_read", false);
    if (error) throw error;

    res.json({ success: true });
  } catch (err) {
    console.error("[/api/seeker/notifications/read-all PATCH] error:", err);
    res.status(500).json({ success: false, message: err.message || "Something went wrong." });
  }
}

// DELETE /api/seeker/notifications/:id
export async function deleteNotification(req, res) {
  try {
    const { error } = await supabase
      .from("seeker_notifications")
      .delete()
      .eq("id", req.params.id)
      .eq("user_id", getSeekerId(req));
    if (error) throw error;

    res.json({ success: true });
  } catch (err) {
    console.error("[/api/seeker/notifications/:id DELETE] error:", err);
    res.status(500).json({ success: false, message: err.message || "Something went wrong." });
  }
}