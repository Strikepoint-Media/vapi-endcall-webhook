// index.js  (ESM)

import express from "express";
import fetch from "node-fetch";

const app = express();
const PORT = process.env.PORT || 10000;

// Only need Zapier URL now
const ZAPIER_HOOK_URL = process.env.ZAPIER_HOOK_URL;

app.use(express.json());

/**
 * Try to derive a lead score + label from Vapi structured outputs.
 * Looks for the "Success Evaluation" structured output and maps:
 *  - engaged_and_reachable -> 70
 *  - answered_not_fully_engaged -> 50
 *  - invalid_or_unreachable/Invalid/unreachable -> 0
 */
function deriveLeadScore(structuredOutputs) {
  if (!structuredOutputs) return {};

  let label = null;
  let score;
  let rawResult = null;

  for (const [id, so] of Object.entries(structuredOutputs)) {
    if (!so || !so.name) continue;
    const nameLower = String(so.name).toLowerCase();

    if (nameLower.includes("success evaluation")) {
      rawResult = so.result;

      // Case 1: result is already an object like { label, score, reason }
      if (rawResult && typeof rawResult === "object") {
        if (rawResult.label) label = rawResult.label;
        if (rawResult.score !== undefined) {
          score = rawResult.score;
          break;
        }
      }

      // Case 2: result is a JSON string
      if (typeof rawResult === "string") {
        const trimmed = rawResult.trim();
        try {
          const parsed = JSON.parse(trimmed);
          if (parsed && typeof parsed === "object") {
            if (parsed.label) label = parsed.label;
            if (parsed.score !== undefined) {
              score = parsed.score;
              break;
            }
          } else {
            // Plain label string like "Invalid/unreachable"
            label = trimmed;
          }
        } catch {
          // Not JSON, treat as plain label string
          label = trimmed;
        }
      }

      // We found the "Success Evaluation" output; no need to keep looping
      break;
    }
  }

  if (!label && score === undefined) {
    return {};
  }

  // If Vapi didn’t give a numeric score, derive it from the label
  if (score === undefined && label) {
    const norm = label.toLowerCase();

    if (norm.includes("engaged_and_reachable") || norm.includes("engaged and reachable")) {
      score = 70;
    } else if (
      norm.includes("answered_not_fully_engaged") ||
      norm.includes("answered not fully engaged")
    ) {
      score = 50;
    } else if (
      norm.includes("invalid/unreachable") ||
      norm.includes("invalid_or_unreachable")
    ) {
      score = 0;
    } else {
      // Fallback: unknown label, treat as 0 for safety
      score = 0;
    }
  }

  const result = {};
  if (label) result.label = label;
  if (score !== undefined) result.score = score;

  return result;
}

/**
 * Normalize the Vapi webhook payload (handles both wrapped `message`
 * and potential direct payloads). No enrichment, no null defaults.
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
    msg.structuredOutputs || msg.artifact?.structuredOutputs;
  const scorecards = msg.scorecards;

  const cleaned = {
    eventType,
    rawEventType: eventType,
  };

  // ---- Call block ----
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
  if (Object.keys(call).length > 0) cleaned.call = call;

  // ---- Customer block ----
  const customer = {};
  const number =
    customerObj.number ||
    customerObj.phone ||
    customerObj.phoneNumber;
  if (number) customer.number = number;
  if (customerObj.name) customer.name = customerObj.name;
  if (customerObj.metadata) customer.metadata = customerObj.metadata;
  if (Object.keys(customer).length > 0) cleaned.customer = customer;

  // ---- Analysis block ----
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

  // Derive lead score / label from structured outputs
  const leadEval = deriveLeadScore(structuredOutputs);
  if (leadEval.score !== undefined) {
    analysis.score = leadEval.score;
    cleaned.leadScore = leadEval.score;
  }
  if (leadEval.label) {
    cleaned.leadLabel = leadEval.label;
  }

  if (Object.keys(analysis).length > 0) cleaned.analysis = analysis;

  // ---- Extras ----
  if (structuredOutputs) cleaned.structuredOutputs = structuredOutputs;
  if (msg.transcript) cleaned.transcript = msg.transcript;
  if (msg.recordingUrl) cleaned.recordingUrl = msg.recordingUrl;
  if (msg.stereoRecordingUrl)
    cleaned.stereoRecordingUrl = msg.stereoRecordingUrl;
  if (scorecards) cleaned.scorecards = scorecards;

  return cleaned;
}

// ---- Webhook route ----
app.post("/vapi-hook", async (req, res) => {
  try {
    console.log("Incoming Vapi event:", JSON.stringify(req.body, null, 2));

    const cleaned = mapVapiEvent(req.body);

    console.log(
      "Forwarding cleaned payload to Zapier:",
      JSON.stringify(cleaned, null, 2)
    );

    if (!ZAPIER_HOOK_URL) {
      console.warn(
        "ZAPIER_HOOK_URL is not set – skipping forward to Zapier."
      );
    } else {
      try {
        const zapResp = await fetch(ZAPIER_HOOK_URL, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(cleaned),
        });
        console.log(
          `Zapier response status: ${zapResp.status} ${zapResp.statusText}`
        );
      } catch (err) {
        console.error("Error forwarding to Zapier:", err);
      }
    }

    res.status(200).json({ ok: true }); // Always acknowledge
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
  console.log(`ZAPIER_HOOK_URL present: ${!!ZAPIER_HOOK_URL}`);
});
