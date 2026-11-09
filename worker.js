require("dotenv").config();

const { createClient } = require("@supabase/supabase-js");

// ================================
// CONFIGURATION
// ================================

const RESULT_API =
  "https://draw.ar-lottery01.com/WinGo/WinGo_1M/GetHistoryIssuePage.json";

const PLANNER_BASE =
  "https://wingo.oss-ap-southeast-7.aliyuncs.com/WinGo_1_";

const INTERVAL = 5000; // Check every 5 seconds

// ================================
// SUPABASE CONNECTION
// ================================

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl || !supabaseKey) {
  console.error("❌ Supabase credentials missing in .env");
  process.exit(1);
}

const supabase = createClient(supabaseUrl, supabaseKey);

// ================================
// HELPER FUNCTIONS
// ================================

// Get period number from API item
function getIssue(item) {
  return String(
    item.issueNumber ?? item.issue ?? item.period ?? ""
  );
}

// Get result number (0–9)
function getNumber(item) {
  const value =
    item.number ?? item.result ?? item.openNumber;

  if (
    value === undefined ||
    value === null ||
    value === ""
  ) {
    return null;
  }

  const number = Number(value);

  if (
    Number.isInteger(number) &&
    number >= 0 &&
    number <= 9
  ) {
    return number;
  }

  return null;
}

// Convert number to Big / Small
function getSize(number) {
  return number >= 5 ? "Big" : "Small";
}

// Calculate next period safely
function nextPeriod(period) {
  return (BigInt(period) + 1n)
    .toString()
    .padStart(period.length, "0");
}

// Find results list in API response
function extractResults(json) {
  const candidates = [
    json?.data?.list,
    json?.data?.data?.list,
    json?.list,
    json?.data?.records,
    json?.records
  ];

  return candidates.find(Array.isArray) || [];
}

// ================================
// FETCH ALL AVAILABLE RESULTS
// ================================

async function fetchResults() {
  const response = await fetch(
    RESULT_API + "?_ts=" + Date.now(),
    {
      cache: "no-store"
    }
  );

  if (!response.ok) {
    throw new Error(
      `Results API error: ${response.status}`
    );
  }

  const json = await response.json();
  const list = extractResults(json);

  if (!list.length) {
    throw new Error(
      "Results API returned no results"
    );
  }

  const results = list
    .filter(item => {
      return /^\d+$/.test(getIssue(item));
    })
    .sort((a, b) => {
      const x = BigInt(getIssue(a));
      const y = BigInt(getIssue(b));

      if (x > y) return -1;
      if (x < y) return 1;

      return 0;
    });

  return results;
}

// ================================
// FETCH PLANNER PREDICTION
// ================================

async function fetchPlannerPrediction(targetPeriod) {
  const url =
    `${PLANNER_BASE}${targetPeriod}_planner4_bs_plan`;

  const response = await fetch(url, {
    cache: "no-store"
  });

  if (!response.ok) {
    throw new Error(
      `Planner API error: ${response.status}`
    );
  }

  const json = await response.json();
  const code = json?.content?.bs;

  if (code !== "b" && code !== "s") {
    throw new Error(
      "Invalid planner signal"
    );
  }

  return code === "b" ? "Big" : "Small";
}

// ================================
// VERIFY PENDING PREDICTIONS
// ================================

async function verifyPendingPredictions(results) {
  const { data: pendingPredictions, error } =
    await supabase
      .from("prediction_history")
      .select("*")
      .eq("status", "Pending");

  if (error) {
    throw new Error(
      `Database read error: ${error.message}`
    );
  }

  if (!pendingPredictions || !pendingPredictions.length) {
    console.log("📭 No pending predictions");
    return;
  }

  // Create Period → Actual Size map
  const actualResults = new Map();

  for (const item of results) {
    const period = getIssue(item);
    const number = getNumber(item);

    if (period && number !== null) {
      actualResults.set(
        period,
        getSize(number)
      );
    }
  }

  // Check every pending prediction
  for (const prediction of pendingPredictions) {
    const actual =
      actualResults.get(prediction.period);

    // Result is not available yet
    if (!actual) continue;

    const status =
      actual === prediction.prediction
        ? "Win"
        : "Loss";

    const { error: updateError } =
      await supabase
        .from("prediction_history")
        .update({
          actual: actual,
          status: status,
          updated_at: new Date().toISOString()
        })
        .eq("id", prediction.id);

    if (updateError) {
      console.error(
        `❌ Failed to update ${prediction.period}:`,
        updateError.message
      );
    } else {
      const icon =
        status === "Win" ? "🏆" : "❌";

      console.log(
        `${icon} ${prediction.period} → ` +
        `Prediction: ${prediction.prediction} | ` +
        `Actual: ${actual} | ${status}`
      );
    }
  }
}

// ================================
// CREATE NEW PREDICTION
// ================================

async function createPrediction(latestResult) {
  const latestPeriod =
    getIssue(latestResult);

  const targetPeriod =
    nextPeriod(latestPeriod);

  console.log(
    "🎯 Target period:",
    targetPeriod
  );

  // Check if prediction already exists
  const { data: existing, error: checkError } =
    await supabase
      .from("prediction_history")
      .select("id, period, prediction, status")
      .eq("period", targetPeriod)
      .maybeSingle();

  if (checkError) {
    throw new Error(
      `Database check error: ${checkError.message}`
    );
  }

  // Already exists: don't call planner again
  if (existing) {
    console.log(
      `⏭️ Already saved: ${existing.prediction} (${existing.status})`
    );

    return;
  }

  // Fetch new prediction
  console.log(
    "🤖 Fetching new planner signal..."
  );

  const prediction =
    await fetchPlannerPrediction(targetPeriod);

  console.log(
    "🤖 New prediction:",
    prediction
  );

  // Save prediction
  const { data, error } =
    await supabase
      .from("prediction_history")
      .insert({
        period: targetPeriod,
        prediction: prediction,
        status: "Pending"
      })
      .select();

  if (error) {
    throw new Error(
      `Database save error: ${error.message}`
    );
  }

  console.log(
    "💾 New prediction saved:",
    data
  );
}

// ================================
// MAIN WORKER CYCLE
// ================================

async function workerCycle() {
  console.log(
    "\n🔄 Worker cycle:",
    new Date().toLocaleTimeString()
  );

  try {
    // 1. Fetch all current results
    const results = await fetchResults();

    const latest = results[0];

    if (!latest) {
      throw new Error(
        "No latest result available"
      );
    }

    const latestNumber =
      getNumber(latest);

    console.log(
      "📊 Latest result:",
      {
        period: getIssue(latest),
        number: latestNumber,
        size:
          latestNumber !== null
            ? getSize(latestNumber)
            : null
      }
    );

    // 2. Verify old pending predictions
    console.log(
      "🔍 Checking pending predictions..."
    );

    await verifyPendingPredictions(results);

    // 3. Create prediction for next period
    await createPrediction(latest);

  } catch (error) {
    console.error(
      "❌ Worker error:",
      error.message
    );
  }
}

// ================================
// CONTINUOUS BACKGROUND LOOP
// ================================

let isRunning = false;

async function runWorker() {
  // Prevent overlapping cycles
  if (isRunning) return;

  isRunning = true;

  try {
    await workerCycle();
  } finally {
    isRunning = false;
  }
}

// Start immediately
runWorker();

// Continue every 5 seconds
setInterval(runWorker, INTERVAL);

// Keep process error-safe
process.on("unhandledRejection", error => {
  console.error(
    "❌ Unhandled rejection:",
    error.message
  );
});

console.log(
  "🚀 Wingo Background Worker started"
);