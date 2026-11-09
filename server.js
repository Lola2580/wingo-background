require("dotenv").config();

const express = require("express");
const { createClient } = require("@supabase/supabase-js");

const app = express();

const PORT = process.env.PORT || 5000;

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

// Check environment variables
if (!supabaseUrl || !supabaseKey) {
  console.error("❌ Supabase credentials missing in .env file");
  process.exit(1);
}

// Create Supabase client
const supabase = createClient(supabaseUrl, supabaseKey);

app.get("/", (req, res) => {
  res.json({
    status: "running",
    message: "Wingo Background Worker is running"
  });
});

// Test Supabase connection
app.get("/health", async (req, res) => {
  try {
    const { error } = await supabase
      .from("prediction_history")
      .select("id")
      .limit(1);

    if (error) throw error;

    res.json({
      status: "ok",
      database: "connected"
    });
  } catch (error) {
    console.error("Database error:", error.message);

    res.status(500).json({
      status: "error",
      database: "disconnected",
      message: error.message
    });
  }
});

app.listen(PORT, () => {
  console.log(`🚀 Server running on http://localhost:${PORT}`);
});