// index.js
import express from "express";
import bodyParser from "body-parser";
import fetch from "node-fetch";

const app = express();
app.use(bodyParser.json());

// ----- ENV VARS -----
const { ZAPIER_HOOK_URL, ABSTRACT_PHONE_API_KEY } = process.env;

// -------------------------------------------
// Phone enrichment via Abstract Phone Intelligence API
// -------------------------------------------
async function enrichPhone(phoneNumber) {
  if (!ABSTRACT_PHONE_API_KEY || !phoneNumber) return null;

  try {
    const url = `https://phoneintelligence.abstractapi.com/v1/?api_key=${ABSTRACT_PHONE_API_KEY}&phone=${encodeURIComponent(
      phoneNumber
    )}`;

    const res = await fetch(url);
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      console.error("Phone enrichment HTTP error:", res.status, text);
      return null;
    }

    const data = await res.json();
    return data;
  } catch (err) {
    console.error("Phone enrichment error:", err);
    return null;
  }
}

// -------------------------------------------
// Identity & Contact Validation score (0–70)
// based on descriptive outcome + duration
// -------------------------------------------
function getIdentityScore(descriptiveOutcome, durationSeconds) {
  if (!descriptiveOutcome) return 0;

  const label = descriptiveOutcome.toLowerCase();
  let baseScore;

  if (label.includes("invalid") || label.includes("unreachable")) {
    baseScore = 0;
  } else if (label.includes("excellent")) {
    baseScore = 70;
  } else if (label.includes("good")) {
    baseScore = 55;
  } else if (label.includes("fair")) {
    baseScore = 40;
  } else if (label.includes("poor")) {
    baseScore = 15;
  } else {
    baseScore = 0;
  }

  // If the call was short, cap "excellent" style scores
  if (durationSeconds != null && durationSeconds < 30 && baseScore > 50) {
    baseScore = 50;
  }

  return baseScore;
}

// -------------------------------------------
// Decide if this Vapi event should be forwarded
// -------------------------------------------
function shouldForward(msg) {
  const type = msg.type;
  const endedReason = msg.endedReason || msg.call?.endedReason || null;

  // Always take full end-of-call reports
  if (type === "end-of-call-report") return true;

  // For status-updates, only forward when we have an end reason
  // (covers edge cases where end-of-call-report never arrives)
  if (type === "status-update") {
    if (!endedReason) return false;
    return true;
  }

  return false;
}

// -------------------------------------------
// Routes
// -------------------------------------------
app.get("/", (req, res) => {
  res.send("Vapi end-of-call webhook is running");
});

app.post("/", async (req, res) => {
  try {
    const msg = req.body?.message || {};
    const artifact = msg.artifact || {};
    const analysis = msg.analysis || {};
    const variables = artifact.variables || msg.variables || {};

    console.log("Incoming Vapi event type:", msg.type);

    if (!shouldForward(msg)) {
      return res.json({ ok: true, forwarded: false });
    }

    // ----- Core call + customer info -----
    const call = msg.call || {};

    const customerNumber =
      variables.customer?.number ||
      variables.phoneNumber?.customerNumber ||
      msg.customer?.number ||
      null;

    const durationSeconds =
      msg.durationSeconds ?? call.durationSeconds ?? null;

    const callInfo = {
      id: call.id || msg.callId || null,
      startedAt: msg.startedAt || call.startedAt || null,
      endedAt: msg.endedAt || call.endedAt || null,
      endedReason: msg.endedReason || call.endedReason || null,
      durationSeconds,
      durationMinutes: msg.durationMinutes ?? call.durationMinutes ?? null,
      durationMs: msg.durationMs ?? call.durationMs ?? null,
      cost: msg.cost ?? call.cost ?? 0,
    };

    // ----- Analysis: success eval + structured output -----
    const successEvaluation = analysis.successEvaluation ?? null;

    const structured =
      analysis.structuredOutputs || msg.structuredOutputs || {};

    // Try multiple key styles in case Vapi slugs the name
    const descriptiveOutcome =
      structured["Success Evaluation - Descriptive"] ||
      structured.successEvaluationDescriptive ||
      structured.success_evaluation_descriptive ||
      null;

    const identityValidationScore = getIdentityScore(
      descriptiveOutcome,
      durationSeconds
    );

    const analysisInfo = {
      successEvaluation, // whatever Vapi returns here (pass/fail/etc.)
      descriptiveOutcome, // Excellent / Good / Fair / Poor / Invalid / Unreachable
      identityValidationScore, // 0–70
      summary: msg.summary || analysis.summary || null,
    };

    // ----- Transcript + recordings -----
    const transcriptInfo = {
      transcript: msg.transcript || artifact.transcript || null,
      recordingUrl: msg.recordingUrl || artifact.recordingUrl || null,
      stereoRecordingUrl:
        msg.stereoRecordingUrl || artifact.stereoRecordingUrl || null,
      logUrl: msg.logUrl || artifact.logUrl || null,
    };

    // ----- Transport (Twilio etc.) -----
    const transport =
      variables.transport || msg.transport || call.transport || {};

    const transportInfo = {
      provider: transport.provider || null,
      conversationType: transport.conversationType || null,
      callSid: transport.callSid || null,
      accountSid: transport.accountSid || null,
    };

    // ----- Phone enrichment -----
    const phoneEnrichmentRaw = await enrichPhone(customerNumber);

    const phoneEnrichment = phoneEnrichmentRaw
      ? {
          raw: phoneEnrichmentRaw,
          valid: phoneEnrichmentRaw.phone_validation?.is_valid ?? null,
          lineType: phoneEnrichmentRaw.phone_carrier?.line_type || null,
          carrier: phoneEnrichmentRaw.phone_carrier?.name || null,
          location: phoneEnrichmentRaw.phone_location?.region || null,
          city: phoneEnrichmentRaw.phone_location?.city || null,
          countryName: phoneEnrichmentRaw.phone_location?.country_name || null,
        }
      : null;

    // ----- Final payload to Zapier -----
    const outgoingPayload = {
      eventType: msg.type || null,
      call: callInfo,
      analysis: analysisInfo,
      transcript: transcriptInfo,
      customer: {
        number: customerNumber,
      },
      transport: transportInfo,
      phoneEnrichment,
    };

    console.log("Forwarding cleaned payload to Zapier:", {
      eventType: outgoingPayload.eventType,
      call: outgoingPayload.call,
      analysis: {
        descriptiveOutcome: outgoingPayload.analysis.descriptiveOutcome,
        identityValidationScore:
          outgoingPayload.analysis.identityValidationScore,
      },
      customer: outgoingPayload.customer,
    });

    if (!ZAPIER_HOOK_URL) {
      console.error("ZAPIER_HOOK_URL is not set");
      return res
        .status(500)
        .json({ error: "ZAPIER_HOOK_URL is not configured" });
    }

    const zapRes = await fetch(ZAPIER_HOOK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(outgoingPayload),
    });

    if (!zapRes.ok) {
      const text = await zapRes.text().catch(() => "");
      console.error("Error forwarding to Zapier:", zapRes.status, text);
    }

    res.json({ ok: true, forwarded: true });
  } catch (err) {
    console.error("Webhook handler error:", err);
    res.status(500).json({ error: "Server error" });
  }
});

// -------------------------------------------
// Start server
// -------------------------------------------
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`Middleware running on port ${PORT}`);
});
