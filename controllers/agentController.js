// controllers/agentController.js
import { supabase } from "../config/supabase.js";

// POST /api/agents/register  { name, phone, email }
// Idempotent: if an agent with this phone already exists, returns it instead
// of creating a duplicate. Call this from your job-posting flow whenever
// posted_by_type === 'agent', then use the returned agent.id as jobs.agent_id.
export async function registerOrGetAgent(req, res) {
  try {
    const { name, phone, email } = req.body;
    if (!name || !phone) {
      return res.status(400).json({ success: false, message: "name and phone are required" });
    }

    const { data: existing } = await supabase.from("agents").select("*").eq("phone", phone).single();

    if (existing) {
      return res.json({ success: true, agent: existing });
    }

    const { data: created, error } = await supabase
      .from("agents")
      .insert({ name, phone, email })
      .select()
      .single();
    if (error) throw error;

    res.json({ success: true, agent: created });
  } catch (err) {
    console.error("registerOrGetAgent error:", err);
    res.status(500).json({ success: false, message: "Failed to register agent" });
  }
}

// GET /api/agents/:phone/commissions
// Simple phone-based lookup for now since agents don't have full accounts yet.
export async function getAgentCommissions(req, res) {
  try {
    const { phone } = req.params;

    const { data: agent, error: agentErr } = await supabase
      .from("agents")
      .select("id, name, phone, commission_rate")
      .eq("phone", phone)
      .single();
    if (agentErr || !agent) {
      return res.status(404).json({ success: false, message: "Agent not found" });
    }

    const { data: commissions, error: commErr } = await supabase
      .from("agent_commissions")
      .select("id, job_id, commission_amount, currency, status, created_at, jobs(title)")
      .eq("agent_id", agent.id)
      .order("created_at", { ascending: false });
    if (commErr) throw commErr;

    const totalEarned = commissions
      .filter((c) => c.status === "paid")
      .reduce((sum, c) => sum + Number(c.commission_amount), 0);
    const totalPending = commissions
      .filter((c) => c.status === "pending")
      .reduce((sum, c) => sum + Number(c.commission_amount), 0);

    res.json({ success: true, agent, total_earned: totalEarned, total_pending: totalPending, commissions });
  } catch (err) {
    console.error("getAgentCommissions error:", err);
    res.status(500).json({ success: false, message: "Failed to get agent commissions" });
  }
}