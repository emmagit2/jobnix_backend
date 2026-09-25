// controllers/corporateNotificationController.js
//
// Mirrors controllers/notificationController.js but scopes every query to
// the logged-in corporate account instead of a business.
//
// ASSUMPTION: a requireCorporateAccount middleware (mirroring
// requireBusinessAccount) attaches the corporate account's id as
// req.corporateId. Adjust getCorporateId() below if yours differs.
//
// Expects a `corporate_notifications` table shaped like `notifications` but
// with a `corporate_id` column instead of `business_id`:
//   id, corporate_id, type, title, body, link, metadata, is_read, created_at

import { supabase } from "../config/supabase.js";

function getCorporateId(req) {
  return req.corporateId; // adjust to match your requireCorporateAccount middleware
}

// GET /api/corporate/notifications?limit=20&before=<created_at>
export async function listNotifications(req, res) {
  try {
    const corporateId = getCorporateId(req);
    const limit = Math.min(Number(req.query.limit) || 20, 50);

    let query = supabase
      .from("corporate_notifications")
      .select("id, type, title, body, link, metadata, is_read, created_at")
      .eq("corporate_id", corporateId)
      .order("created_at", { ascending: false })
      .limit(limit);

    if (req.query.before) {
      query = query.lt("created_at", req.query.before);
    }

    const { data, error } = await query;
    if (error) throw error;

    const { count, error: countErr } = await supabase
      .from("corporate_notifications")
      .select("id", { count: "exact", head: true })
      .eq("corporate_id", corporateId)
      .eq("is_read", false);
    if (countErr) throw countErr;

    res.json({ success: true, notifications: data, unread_count: count || 0 });
  } catch (err) {
    console.error("[/api/corporate/notifications GET] error:", err);
    res.status(500).json({ success: false, message: err.message || "Something went wrong." });
  }
}

// PATCH /api/corporate/notifications/:id/read
export async function markAsRead(req, res) {
  try {
    const { error } = await supabase
      .from("corporate_notifications")
      .update({ is_read: true })
      .eq("id", req.params.id)
      .eq("corporate_id", getCorporateId(req)); // can't mark someone else's notification read
    if (error) throw error;

    res.json({ success: true });
  } catch (err) {
    console.error("[/api/corporate/notifications/:id/read PATCH] error:", err);
    res.status(500).json({ success: false, message: err.message || "Something went wrong." });
  }
}

// PATCH /api/corporate/notifications/read-all
export async function markAllAsRead(req, res) {
  try {
    const { error } = await supabase
      .from("corporate_notifications")
      .update({ is_read: true })
      .eq("corporate_id", getCorporateId(req))
      .eq("is_read", false);
    if (error) throw error;

    res.json({ success: true });
  } catch (err) {
    console.error("[/api/corporate/notifications/read-all PATCH] error:", err);
    res.status(500).json({ success: false, message: err.message || "Something went wrong." });
  }
}

// DELETE /api/corporate/notifications/:id
export async function deleteNotification(req, res) {
  try {
    const { error } = await supabase
      .from("corporate_notifications")
      .delete()
      .eq("id", req.params.id)
      .eq("corporate_id", getCorporateId(req));
    if (error) throw error;

    res.json({ success: true });
  } catch (err) {
    console.error("[/api/corporate/notifications/:id DELETE] error:", err);
    res.status(500).json({ success: false, message: err.message || "Something went wrong." });
  }
}