// controllers/notificationController.js
import { supabase } from "../config/supabase.js";
import * as prefsRepo from "../lib/notificationPreferencesRepo.js";

// GET /api/notifications/preferences
export async function getPreferences(req, res) {
  try {
    const prefs = await prefsRepo.get(req.businessId);
    res.json(toClientShape(prefs));
  } catch (err) {
    console.error("[/api/notifications/preferences GET] error:", err);
    res.status(500).json({ success: false, message: err.message || "Something went wrong." });
  }
}

// PUT /api/notifications/preferences — the "Save Preferences" button
export async function savePreferences(req, res) {
  try {
    const prefs = await prefsRepo.update(req.businessId, {
      new_applicant: req.body.newApplicant,
      job_expiring_soon: req.body.jobExpiringSoon,
      messages: req.body.messages,
      weekly_summary: req.body.weeklySummary,
      application_status_change: req.body.applicationStatusChange,
      payment_success: req.body.paymentSuccess,
      referral_commission: req.body.referralCommission,
    });
    res.json(toClientShape(prefs));
  } catch (err) {
    console.error("[/api/notifications/preferences PUT] error:", err);
    res.status(500).json({ success: false, message: err.message || "Something went wrong." });
  }
}

function toClientShape(prefs) {
  return {
    newApplicant: prefs.new_applicant,
    jobExpiringSoon: prefs.job_expiring_soon,
    messages: prefs.messages,
    weeklySummary: prefs.weekly_summary,
    applicationStatusChange: prefs.application_status_change,
    paymentSuccess: prefs.payment_success,
    referralCommission: prefs.referral_commission,
  };
}

// =============================
// IN-APP NOTIFICATION FEED (bell icon)
// =============================

// GET /api/notifications?limit=20&before=<created_at>
export async function listNotifications(req, res) {
  try {
    const limit = Math.min(Number(req.query.limit) || 20, 50);

    let query = supabase
      .from("notifications")
      .select("id, type, title, body, link, metadata, is_read, created_at")
      .eq("business_id", req.businessId)
      .order("created_at", { ascending: false })
      .limit(limit);

    if (req.query.before) {
      query = query.lt("created_at", req.query.before);
    }

    const { data, error } = await query;
    if (error) throw error;

    const { count, error: countErr } = await supabase
      .from("notifications")
      .select("id", { count: "exact", head: true })
      .eq("business_id", req.businessId)
      .eq("is_read", false);
    if (countErr) throw countErr;

    res.json({ success: true, notifications: data, unread_count: count || 0 });
  } catch (err) {
    console.error("[/api/notifications GET] error:", err);
    res.status(500).json({ success: false, message: err.message || "Something went wrong." });
  }
}

// PATCH /api/notifications/:id/read
export async function markAsRead(req, res) {
  try {
    const { error } = await supabase
      .from("notifications")
      .update({ is_read: true })
      .eq("id", req.params.id)
      .eq("business_id", req.businessId); // can't mark someone else's notification read
    if (error) throw error;

    res.json({ success: true });
  } catch (err) {
    console.error("[/api/notifications/:id/read PATCH] error:", err);
    res.status(500).json({ success: false, message: err.message || "Something went wrong." });
  }
}

// PATCH /api/notifications/read-all
export async function markAllAsRead(req, res) {
  try {
    const { error } = await supabase
      .from("notifications")
      .update({ is_read: true })
      .eq("business_id", req.businessId)
      .eq("is_read", false);
    if (error) throw error;

    res.json({ success: true });
  } catch (err) {
    console.error("[/api/notifications/read-all PATCH] error:", err);
    res.status(500).json({ success: false, message: err.message || "Something went wrong." });
  }
}

// =============================
// PUSH SUBSCRIPTIONS (Web Push / VAPID)
// =============================

// POST /api/notifications/push/subscribe
// body: the raw PushSubscription.toJSON() object from the browser:
//   { endpoint, keys: { p256dh, auth } }
export async function subscribePush(req, res) {
  try {
    const { endpoint, keys } = req.body;
    if (!endpoint || !keys?.p256dh || !keys?.auth) {
      return res.status(400).json({ success: false, message: "Invalid push subscription payload" });
    }

    const { error } = await supabase.from("push_subscriptions").upsert(
      {
        business_id: req.businessId,
        endpoint,
        p256dh: keys.p256dh,
        auth: keys.auth,
      },
      { onConflict: "endpoint" }
    );
    if (error) throw error;

    res.json({ success: true });
  } catch (err) {
    console.error("[/api/notifications/push/subscribe POST] error:", err);
    res.status(500).json({ success: false, message: err.message || "Something went wrong." });
  }
}

// POST /api/notifications/push/unsubscribe   body: { endpoint }
export async function unsubscribePush(req, res) {
  try {
    const { endpoint } = req.body;
    if (!endpoint) {
      return res.status(400).json({ success: false, message: "endpoint is required" });
    }

    const { error } = await supabase
      .from("push_subscriptions")
      .delete()
      .eq("endpoint", endpoint)
      .eq("business_id", req.businessId);
    if (error) throw error;

    res.json({ success: true });
  } catch (err) {
    console.error("[/api/notifications/push/unsubscribe POST] error:", err);
    res.status(500).json({ success: false, message: err.message || "Something went wrong." });
  }
}

// GET /api/notifications/push/vapid-public-key
// Frontend needs this to call PushManager.subscribe({ applicationServerKey: ... })
export async function getVapidPublicKey(req, res) {
  res.json({ success: true, publicKey: process.env.VAPID_PUBLIC_KEY });
}
// DELETE /api/notifications/:id
export async function deleteNotification(req, res) {
  try {
    const { error } = await supabase
      .from("notifications")
      .delete()
      .eq("id", req.params.id)
      .eq("business_id", req.businessId);
    if (error) throw error;
    res.json({ success: true });
  } catch (err) {
    console.error("[/api/notifications/:id DELETE] error:", err);
    res.status(500).json({ success: false, message: err.message || "Something went wrong." });
  }
}