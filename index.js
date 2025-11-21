// index.js (ESM)

import express from "express";
import fetch from "node-fetch";

const app = express();
const PORT = process.env.PORT || 10000;

const ZAPIER_HOOK_URL = process.env.ZAPIER_HOOK_URL;

// In-memory buffer so we only send ONE event per call to Zapier
// Shape: { [callId]: { data: <mergedCleaned>, timeoutId: Timeout } }
const callBuffer = new Map();

// How long to wait (ms) before sending a partial event
// if we never receive an end-of-call-report
const FALLBACK_TIMEOUT_MS = 60_000;

app.use(express.json());

/**
 * Safely deep-merge two plain objects (b overwrites a).
 * We only care about shallow-ish nested objects: call, customer, analysis, etc.
 */
function deepMerge(a = {}, b = {}) {
  const out = { ...a };
  for (const [key, value] of Object.entries(b)) {
    if (
      value &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      typeof a[key] === "object" &&
      a[key] !== null &&
      !Array.isArray(a[key])
    ) {
      out[key] = deepMerge(a[key], value);
    } else {
      out[key] = value;
    }
  }
  return out;
}

/**
 * Normalize the Vapi webhook payload (handles wrapped `message`).
 * Also extracts lead label from structuredOutputs and maps it to a leadScore.
 */
function mapVapiEvent(body) {
  const msg = body.message || body || {};

  const eventType = msg.type || body.type || "unknown";

  const callObj = msg.call || msg.artifact?.call || {};
  const customerObj =
    msg.customer ||
    msg.variables?.customer ||
    msg.variableValues?.customer ||
    {};
  const analysisObj = msg.analysis || {};

  const structuredOutputs =
    msg.structuredOutputs || msg.artifact?.structuredOutputs || null;
  const scorecards = msg.scorecards || null;

  // --- Build core objects with only existing values ---

  const call = {};
  if (callObj.id) call.id = callObj.id;
  if (msg.startedAt || callObj.startedAt)
    call.startedAt = msg.startedAt || callObj.startedAt;
  if (msg.endedAt || callObj.endedAt)
    call.endedAt = msg.endedAt || callObj.endedAt;
  if (msg.endedReason) call.endedReason = msg.endedReason;
  if (msg.durationSeconds !== undefined)
    call.durationSeconds = msg.durationSeconds;
  if (msg.durationMinutes !== undefined)
    call.durationMinutes = msg.durationMinutes;
  if (msg.durationMs !== undefined) call.durationMs = msg.durationMs;
  if (msg.cost !== undefined) call.cost = msg.cost;
  else if (callObj.cost !== undefined) call.cost = callObj.cost;

  const customer = {};
  const number =
    customerObj.number || customerObj.phone || customerObj.phoneNumber;
  if (number) customer.number = number;
  if (customerObj.name) customer.name = customerObj.name;
  if (customerObj.metadata) customer.metadata = customerObj.metadata;

  const analysis = {};
  if (analysisObj.summary || msg.summary)
    analysis.summary = analysisObj.summary || msg.summary;
  if (
    analysisObj.successEvaluation !== undefined ||
    msg.successEvaluation !== undefined
  ) {
    analysis.successEvaluation =
      analysisObj.successEvaluation !== undefined
        ? analysisObj.successEvaluation
        : msg.successEvaluation;
  }
  if (analysisObj.score !== undefined) {
    analysis.score = analysisObj.score;
  }

  const cleaned = {
    eventType,
    call,
    customer,
    analysis,
    rawEventType: eventType,
  };

  if (structuredOutputs) {
    cleaned.structuredOutputs = structuredOutputs;
  }

  if (msg.transcript) cleaned.transcript = msg.transcript;
  if (msg.recordingUrl) cleaned.recordingUrl = msg.recordingUrl;
  if (msg.stereoRecordingUrl)
    cleaned.stereoRecordingUrl = msg.stereoRecordingUrl;

  if (scorecards) cleaned.scorecards = scorecards;

  // --- Derive lead label + score from structuredOutputs, if present ---

  let leadLabel;
  if (structuredOutputs) {
    for (const out of Object.values(structuredOutputs)) {
      if (
        out &&
        typeof out.name === "string" &&
        out.name.toLowerCase().includes("success evaluation")
      ) {
        const res = out.result;
        if (typeof res === "string") {
          leadLabel = res.trim();
        } else if (res && typeof res.label === "string") {
          leadLabel = res.label.trim();
        }
      }
    }
  }

  // Map descriptive label to numeric score
  // Adjust these numbers if you want different weights
  const labelToScore = {
    Excellent: 70,
    Fair: 50,
    "Invalid/unreachable": 0,
    invalid: 0,
    "Invalid_or_unreachable": 0,
  };

  let leadScore;
  if (
    leadLabel &&
    Object.prototype.hasOwnProperty.call(labelToScore, leadLabel)
  ) {
    leadScore = labelToScore[leadLabel];
  }

  if (leadLabel) {
    cleaned.lead = { label: leadLabel };
    if (leadScore !== undefined) {
      cleaned.lead.score = leadScore;
      // Also surface on analysis.score so your existing Zap mapping still works
      cleaned.analysis = cleaned.analysis || {};
      cleaned.analysis.score = leadScore;
    }
  }

  return cleaned;
}

/**
 * Send a single merged payload to Zapier.
 */
async function sendToZapier(payload) {
  console.log(
    "Forwarding merged payload to Zapier:",
    JSON.stringify(payload, null, 2)
  );

  if (!ZAPIER_HOOK_URL) {
    console.warn("ZAPIER_HOOK_URL is not set – skipping forward to Zapier.");
    return;
  }

  const resp = await fetch(ZAPIER_HOOK_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

  console.log(
    `Zapier response status: ${resp.status} ${resp.statusText}`
  );
}

/**
 * Handle a new incoming Vapi event:
 *  - Buffer by callId
 *  - Merge fields
 *  - Only send once (on end-of-call-report, or on timeout fallback)
 */
async function handleVapiEvent(cleaned) {
  const callId = cleaned.call?.id || "unknown-call-id";
  const eventType = cleaned.eventType;

  const existing = callBuffer.get(callId) || { data: {}, timeoutId: null };
  const mergedData = deepMerge(existing.data, cleaned);

  // Always store the latest merged snapshot
  let timeoutId = existing.timeoutId;

  // If this is the final report, send NOW and clear buffer
  if (eventType === "end-of-call-report") {
    if (timeoutId) {
      clearTimeout(timeoutId);
      timeoutId = null;
    }
    callBuffer.delete(callId);

    await sendToZapier(mergedData);
    return;
  }

  // For non-final events (status-updates, etc.), buffer and set a fallback
  // so you still get *something* if end-of-call-report never arrives.
  if (!timeoutId) {
    timeoutId = setTimeout(async () => {
      const buffered = callBuffer.get(callId);
      if (!buffered) return; // already sent

      callBuffer.delete(callId);
      console.log(
        `Fallback timeout hit for call ${callId}, sending buffered data.`
      );
      await sendToZapier(buffered.data);
    }, FALLBACK_TIMEOUT_MS);
  }

  callBuffer.set(callId, { data: mergedData, timeoutId });
}

// ---- Webhook route ----
app.post("/vapi-hook", async (req, res) => {
  try {
    console.log("Incoming Vapi event:", JSON.stringify(req.body, null, 2));

    const cleaned = mapVapiEvent(req.body);

    // Fire and forget; we don't want Vapi to retry while we wait
    handleVapiEvent(cleaned).catch((err) => {
      console.error("Error in handleVapiEvent:", err);
    });

    // Always acknowledge quickly so Vapi doesn't retry
    res.status(200).json({ ok: true });
  } catch (err) {
    console.error("Error in /vapi-hook handler:", err);
    res.status(500).json({ ok: false, error: "Server error" });
  }
});

// Simple health check
app.get("/", (req, res) => {
  res.send("Vapi end-call webhook is running.");
});

app.listen(PORT, () => {
  console.log(`Middleware server running on port ${PORT}`);
});
