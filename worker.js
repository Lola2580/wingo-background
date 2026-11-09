require("dotenv").config();

const { createClient } = require("@supabase/supabase-js");

// ==========================================
// CONFIGURATION
// ==========================================

const RESULT_API =
  "https://draw.ar-lottery01.com/WinGo/WinGo_1M/GetHistoryIssuePage.json";

const PLANNER_BASE =
  "https://wingo.oss-ap-southeast-7.aliyuncs.com/WinGo_1_";

const INTERVAL = 5000;

// Request headers
const API_HEADERS = {
  Accept: "application/json, text/plain, */*",
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  Referer: "https://draw.ar-lottery01.com/",
  Origin: "https://draw.ar-lottery01.com"
};

// ==========================================
// SUPABASE CONNECTION
// ==========================================

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl || !supabaseKey) {
  console.error("❌ Supabase credentials missing");
  process.exit(1);
}

const supabase = createClient(supabaseUrl, supabaseKey);

console.log("✅ Supabase connected");

// ==========================================
// HELPER FUNCTIONS
// ==========================================

function getIssue(item) {
  return String(
    item.issueNumber ??
    item.issue ??
    item.period ??
    ""
  );
}

function getNumber(item) {
  const value =
    item.number ??
    item.result ??
    item.openNumber;

  if (
    value === undefined ||
    value === null ||
    value === ""
  ) {
    return null;
  }

  const number = Number(value);

  return Number.isInteger(number) &&
    number >= 0 &&
    number <= 9
    ? number
    : null;
}

function getSize(number) {
  return number >= 5 ? "Big" : "Small";
}

function nextPeriod(period) {
  return (BigInt(period) + 1n)
    .toString()
    .padStart(period.length, "0");
}

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

// ==========================================
// FETCH RESULTS
// ==========================================

async function fetchResults() {
  const url = RESULT_API + "?_ts=" + Date.now();

  const response = await fetch(url, {
    method: "GET",
    headers: API_HEADERS,
    cache: "no-store"
  });

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
    .filter(item => /^\d+$/.test(getIssue(item)))
    .sort((a, b) => {
      const x = BigInt(getIssue(a));
      const y = BigInt(getIssue(b));

      if (x > y) return -1;
      if (x < y) return 1;

      return 0;
    });

  return results;
}

// ==========================================
// FETCH PLANNER PREDICTION
// ==========================================

async function fetchPlannerPrediction(targetPeriod) {
  const url =
    `${PLANNER_BASE}${targetPeriod}_planner4_bs_plan`;

  const response = await fetch(url, {
    method: "GET",
    headers: API_HEADERS,
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
    throw new Error("Invalid planner signal");
  }

  return code === "b" ? "Big" : "Small";
}

// ==========================================
// VERIFY PENDING PREDICTIONS
// ==========================================

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

  if (!pendingPredictions?.length) {
    console.log("📭 No pending predictions");
    return;
  }

  // Create Period → Result map
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

  // Verify every pending prediction
  for (const prediction of pendingPredictions) {
    const actual =
      actualResults.get(prediction.period);

    // Result not available yet
    if (!actual) continue;

    const status =
      actual === prediction.prediction
        ? "Win"
        : "Loss";

    const { error: updateError } =
      await supabase
        .from("prediction_history")
        .update({
          actual,
          status,
          updated_at: new Date().toISOString()
        })
        .eq("id", prediction.id);

    if (updateError) {
      console.error(
        `❌ Failed to update ${prediction.period}: ${updateError.message}`
      );
      continue;
    }

    const icon =
      status === "Win" ? "🏆" : "❌";

    console.log(
      `${icon} ${prediction.period} → ` +
      `Prediction: ${prediction.prediction} | ` +
      `Actual: ${actual} | ${status}`
    );
  }
}

// ==========================================
// CREATE NEW PREDICTION
// ==========================================

async function createPrediction(latestResult) {
  const latestPeriod =
    getIssue(latestResult);

  const targetPeriod =
    nextPeriod(latestPeriod);

  console.log(
    "🎯 Target period:",
    targetPeriod
  );

  // Check existing prediction
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

  if (existing) {
    console.log(
      `⏭️ Already saved: ${existing.prediction} (${existing.status})`
    );
    return;
  }

  console.log(
    "🤖 Fetching new planner signal..."
  );

  const prediction =
    await fetchPlannerPrediction(targetPeriod);

  console.log(
    "🤖 New prediction:",
    prediction
  );

  // Save to database
  const { data, error } =
    await supabase
      .from("prediction_history")
      .insert({
        period: targetPeriod,
        prediction,
        actual: null,
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

// ==========================================
// MAIN WORKER CYCLE
// ==========================================

async function workerCycle() {
  console.log(
    "\n🔄 Worker cycle:",
    new Date().toLocaleTimeString()
  );

  try {
    // Step 1: Get latest results
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

    // Step 2: Verify previous predictions
    console.log(
      "🔍 Checking pending predictions..."
    );

    await verifyPendingPredictions(results);

    // Step 3: Create next prediction
    await createPrediction(latest);

  } catch (error) {
    console.error(
      "❌ Worker error:",
      error.message
    );
  }
}

// ==========================================
// CONTINUOUS BACKGROUND WORKER
// ==========================================

let isRunning = false;

async function runWorker() {
  // Prevent overlapping worker cycles
  if (isRunning) {
    return;
  }

  isRunning = true;

  try {
    await workerCycle();
  } finally {
    isRunning = false;
  }
}

// ==========================================
// START WORKER
// ==========================================

console.log("🚀 Wingo Background Worker started");

runWorker();

setInterval(runWorker, INTERVAL);

process.on("unhandledRejection", error => {
  console.error(
    "❌ Unhandled rejection:",
    error?.message || error
  );
});

process.on("uncaughtException", error => {
  console.error(
    "❌ Uncaught exception:",
    error?.message || error
  );
});
