// index.js  (ESM)

import express from "express";

const app = express();
const PORT = process.env.PORT || 10000;

// Set these in Render's environment variables
const ZAPIER_HOOK_URL = process.env.ZAPIER_HOOK_URL;
const ABSTRACT_API_KEY = process.env.ABSTRACT_API_KEY;

app.use(express.json());

/**
 * Normalize the Vapi webhook payload (handles both wrapped `message`
 * and potential direct payloads).
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

  // Build objects ONLY with existing values so JSON has no explicit nulls

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
    customerObj.number ||
    customerObj.phone ||
    customerObj.phoneNumber;
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

  return cleaned;
}

/**
 * Enrich a phone number using Abstract's Phone Validation API.
 * Returns an object with only real values, or undefined if nothing usable.
 */
async function enrichPhone(phoneNumber) {
  try {
    if (!phoneNumber) {
      console.warn("No phone number provided for enrichment.");
      return;
    }

    if (!ABSTRACT_API_KEY) {
      console.warn("ABSTRACT_API_KEY is not set – skipping phone enrichment.");
      return;
    }

    const url = `https://phonevalidation.abstractapi.com/v1/?api_key=${ABSTRACT_API_KEY}&phone=${encodeURIComponent(
      phoneNumber
    )}`;

    const resp = await fetch(url);
    if (!resp.ok) {
      console.warn(
        "Abstract API non-200 response:",
        resp.status,
        resp.statusText
      );
      return;
    }

    const data = await resp.json();

    const enrichment = {};

    if (data.valid !== undefined) enrichment.valid = data.valid;
    if (data.type) enrichment.lineType = data.type;
    if (data.carrier) enrichment.carrier = data.carrier;
    if (data.location) enrichment.location = data.location;
    if (data.country && data.country.name) {
      enrichment.countryName = data.country.name;
    }

    // If nothing got set, don't send an empty object
    if (Object.keys(enrichment).length === 0) {
      console.warn("Abstract API returned no usable enrichment data:", data);
      return;
    }

    console.log("Abstract enrichment success:", enrichment);
    return enrichment;
  } catch (err) {
    console.error("Error enriching phone via Abstract:", err);
  }
}

// ---- Webhook route ----
app.post("/vapi-hook", async (req, res) => {
  try {
    console.log("Incoming Vapi event:", JSON.stringify(req.body, null, 2));

    const cleaned = mapVapiEvent(req.body);

    // Enrich phone ONLY if possible; attach ONLY if we get data
    try {
      const enrichment = await enrichPhone(cleaned.customer?.number);
      if (enrichment) {
        cleaned.phoneEnrichment = enrichment;
      } else {
        console.log("No phoneEnrichment attached (no data from Abstract).");
      }
    } catch (e) {
      console.error("Unexpected error during enrichment:", e);
    }

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
