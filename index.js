// index.js  (ESM compatible)

import express from "express";

const app = express();
const PORT = process.env.PORT || 10000;

// Environment variables on Render
const ZAPIER_HOOK_URL = process.env.ZAPIER_HOOK_URL;

app.use(express.json());

// ---- Helper: map incoming Vapi event into a clean payload ----
function mapVapiEvent(body) {
  // Vapi usually sends `type`, but fall back just in case
  const rawType =
    body.type || body.eventType || body.event_type || "unknown";

  const call = body.call || {};
  const customer = body.customer || body.caller || {};

  const analysis = body.analysis || {};
  const structuredOutputs = body.structuredOutputs || null;

  // If in future you re-add phone enrichment here, we’ll fill this in.
  const phoneEnrichmentRaw = body.phoneEnrichment || {};
  const phoneEnrichment = {
    valid: phoneEnrichmentRaw.valid ?? null,
    lineType: phoneEnrichmentRaw.lineType ?? null,
    carrier: phoneEnrichmentRaw.carrier ?? null,
    location: phoneEnrichmentRaw.location ?? null,
    countryName: phoneEnrichmentRaw.countryName ?? null,
  };

  return {
    eventType: rawType,

    call: {
      id: call.id ?? null,
      startedAt: call.startedAt ?? null,
      endedAt: call.endedAt ?? null,
      endedReason: call.endedReason ?? null,
      durationSeconds: call.durationSeconds ?? null,
      durationMinutes: call.durationMinutes ?? null,
      durationMs: call.durationMs ?? null,
      cost: call.cost ?? null,
    },

    customer: {
      number:
        customer.number ||
        customer.phone ||
        customer.phoneNumber ||
        null,
      name: customer.name ?? null,
      metadata: customer.metadata ?? null,
    },

    phoneEnrichment,

    analysis: {
      summary: analysis.summary ?? null,
      successEvaluation: analysis.successEvaluation ?? null,
      score: analysis.score ?? null,
    },

    structuredOutputs,

    // For debugging / filters
    rawEventType: rawType,
  };
}

// ---- Main webhook route ----
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

    // Always acknowledge to Vapi so it doesn’t retry
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

// Start server
app.listen(PORT, () => {
  console.log(`Middleware server running on port ${PORT}`);
});
