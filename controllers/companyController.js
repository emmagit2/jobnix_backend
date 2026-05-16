import { supabase } from "../config/supabase.js";

/* GET ALL */
export const getCompanies = async (req, res) => {
  try {
    const { data, error } = await supabase
      .from("companies")
      .select("*")
      .order("created_at", { ascending: false });

    if (error) {
      console.error("GET COMPANIES ERROR:", error);

      return res.status(500).json({
        success: false,
        message: "Failed to fetch companies",
        error: error.message,
        details: error,
      });
    }

    res.json(data);

  } catch (err) {
    console.error("SERVER ERROR:", err);

    res.status(500).json({
      success: false,
      message: "Server crashed",
      error: err.message,
    });
  }
};

/* CREATE */
export const createCompany = async (req, res) => {
  try {
    const payload = req.body;

    console.log("CREATE COMPANY PAYLOAD:", payload);

    const { data, error } = await supabase
      .from("companies")
      .insert([payload])
      .select()
      .single();

    if (error) {
      console.error("CREATE COMPANY ERROR:", error);

      return res.status(500).json({
        success: false,
        message: "Failed to create company",
        error: error.message,
        details: error,
      });
    }

    res.json(data);

  } catch (err) {
    console.error("SERVER ERROR:", err);

    res.status(500).json({
      success: false,
      message: "Server crashed",
      error: err.message,
    });
  }
};

/* UPDATE */
export const updateCompany = async (req, res) => {
  try {
    const { id } = req.params;
    const payload = req.body;

    console.log("UPDATE COMPANY:", id);
    console.log("PAYLOAD:", payload);

    const { data, error } = await supabase
      .from("companies")
      .update(payload)
      .eq("id", id)
      .select()
      .single();

    if (error) {
      console.error("UPDATE COMPANY ERROR:", error);

      return res.status(500).json({
        success: false,
        message: "Failed to update company",
        error: error.message,
        details: error,
      });
    }

    res.json(data);

  } catch (err) {
    console.error("SERVER ERROR:", err);

    res.status(500).json({
      success: false,
      message: "Server crashed",
      error: err.message,
    });
  }
};

/* DELETE */
export const deleteCompany = async (req, res) => {
  try {
    const { id } = req.params;

    console.log("DELETE COMPANY:", id);

    const { error } = await supabase
      .from("companies")
      .delete()
      .eq("id", id);

    if (error) {
      console.error("DELETE COMPANY ERROR:", error);

      return res.status(500).json({
        success: false,
        message: "Failed to delete company",
        error: error.message,
        details: error,
      });
    }

    res.json({ success: true });

  } catch (err) {
    console.error("SERVER ERROR:", err);

    res.status(500).json({
      success: false,
      message: "Server crashed",
      error: err.message,
    });
  }
};