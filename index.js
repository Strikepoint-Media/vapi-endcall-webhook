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
  // Vapi sends `{ message: { ... } }` to your server
  const msg = body.message || body || {};

  const eventType = msg.type || body.type || "unknown";

  // Core call object
  const callObj = msg.call || msg.artifact?.call || {};

  // Customer info (also potentially present in variables/variableValues)
  const customerObj =
    msg.customer ||
    msg.variables?.customer ||
    msg.variableValues?.customer ||
    {};

  const analysisObj = msg.analysis || {};

  // Structured outputs from your Call Summary + Success Evaluation templates
  const structuredOutputs =
    msg.structuredOutputs || msg.artifact?.structuredOutputs || null;

  // Optional scorecards (future scoring, etc.)
  const scorecards = msg.scorecards || null;

  // Build a cleaned payload with the fields you actually care about
  return {
    // High-level event type from Vapi: "status-update", "end-of-call-report", etc.
    eventType,

    call: {
      id: callObj.id ?? null,
      startedAt: msg.startedAt ?? callObj.startedAt ?? null,
      endedAt: msg.endedAt ?? callObj.endedAt ?? null,
      endedReason: msg.endedReason ?? null,
      durationSeconds: msg.durationSeconds ?? null,
      durationMinutes: msg.durationMinutes ?? null,
      durationMs: msg.durationMs ?? null,
      cost: msg.cost ?? callObj.cost ?? null,
    },

    customer: {
      number:
        customerObj.number ||
        customerObj.phone ||
        customerObj.phoneNumber ||
        null,
      name: customerObj.name ?? null,
      metadata: customerObj.metadata ?? null,
    },

    // Default phone enrichment – will be overridden if enrichment succeeds
    phoneEnrichment: {
      valid: null,
      lineType: null,
      carrier: null,
      location: null,
      countryName: null,
    },

    analysis: {
      // Vapi's analysis.summary (short text summary)
      summary: analysisObj.summary ?? msg.summary ?? null,
      // Vapi's boolean/string successEvaluation ("true"/"false")
      successEvaluation:
        analysisObj.successEvaluation ?? msg.successEvaluation ?? null,
      // Numeric score if/when you add it (or leave null for now)
      score: analysisObj.score ?? null,
    },

    // Your custom structured outputs: Call Summary + Success Evaluation - Descriptive
    structuredOutputs,

    // Transcript and recordings for debugging / QA
    transcript: msg.transcript ?? null,
    recordingUrl: msg.recordingUrl ?? null,
    stereoRecordingUrl: msg.stereoRecordingUrl ?? null,

    // Any scorecards Vapi generates (future use)
    scorecards,

    // Useful for Zapier filtering & debugging
    rawEventType: eventType,
  };
}

/**
 * Enrich a phone number using Abstract's Phone Validation API.
 * Returns a normalized object that plugs directly into `phoneEnrichment`.
 */
async function enrichPhone(phoneNumber) {
  const emptyResult = {
    valid: null,
    lineType: null,
    carrier: null,
    location: null,
    countryName: null,
  };

  try {
    if (!phoneNumber) {
      console.warn("No phone number provided for enrichment.");
      return emptyResult;
    }

    if (!ABSTRACT_API_KEY) {
      console.warn("ABSTRACT_API_KEY is not set – skipping phone enrichment.");
      return emptyResult;
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
      return emptyResult;
    }

    const data = await resp.json();

    // Adjust field names here if your Abstract response is slightly different
    return {
      valid: data.valid ?? null,
      lineType: data.type ?? null,
      carrier: data.carrier ?? null,
      location: data.location ?? null,
      countryName: data.country?.name ?? null,
    };
  } catch (err) {
    console.error("Error enriching phone via Abstract:", err);
    return emptyResult;
  }
}

// ---- Webhook route ----
app.post("/vapi-hook", async (req, res) => {
  try {
    console.log("Incoming Vapi event:", JSON.stringify(req.body, null, 2));

    // Step 1: Normalize the Vapi payload
    const cleaned = mapVapiEvent(req.body);

    // Step 2: Enrich the phone number using Abstract
    const enrichment = await enrichPhone(cleaned.customer.number);
    cleaned.phoneEnrichment = enrichment;

    console.log(
      "Forwarding cleaned payload to Zapier:",
      JSON.stringify(cleaned, null, 2)
    );

    // Step 3: Forward to Zapier
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

    // Always acknowledge the webhook so Vapi doesn't retry
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
