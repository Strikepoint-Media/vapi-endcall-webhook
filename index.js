import express from "express";
import fetch from "node-fetch";
import bodyParser from "body-parser";

const app = express();
app.use(bodyParser.json());

const ZAPIER_HOOK_URL = process.env.ZAPIER_HOOK_URL; // already set in Render

app.post("/", async (req, res) => {
  console.log("🔔 Incoming event from Vapi");

  try {
    const body = req.body || {};
    const message = body.message || {};
    const analysis = message.analysis || {};

    const customer = message.customer || {};
    const phoneNumberObj = message.phoneNumber || {};
    const variables = message.variables || {};
    const transportVars = variables.transport || {};
    const call = body.call || {};              // some call info can be on root
    const callTransport = call.transport || {};

    // Best guess for caller phone
    const phone =
      customer.number ||
      phoneNumberObj.number ||
      null;

    const cleaned = {
      // Identifiers
      callId: call.id || null,
      assistantId: message.assistant?.id || null,

      // Caller info
      phone,

      // ✅ Duration & timing (from ROOT of payload)
      startedAt: body.startedAt || null,
      endedAt: body.endedAt || null,
      durationSeconds: body.durationSeconds ?? null,
      durationMs: body.durationMs ?? null,
      durationMinutes: body.durationMinutes ?? null,
      endedReason: body.endedReason || null,

      // Recording links
      recordingUrl: body.recordingUrl || null,
      stereoRecordingUrl: body.stereoRecordingUrl || null,

      // Cost info
      costTotal: body.cost ?? null,
      costBreakdown: body.costBreakdown ?? null,

      // ✅ Analysis
      successEvaluation: analysis.successEvaluation ?? null,
      analysisSummary: analysis.summary ?? null,

      // Human-readable summary/transcript (also on ROOT in your sample)
      summary: body.summary || null,
      transcript: body.transcript || null,

      // Transport / Twilio info
      transportProvider:
        transportVars.provider ||
        callTransport.provider ||
        null,
      callSid:
        transportVars.callSid ||
        callTransport.callSid ||
        null,
      accountSid:
        transportVars.accountSid ||
        callTransport.accountSid ||
        null,
    };

    console.log("📦 Forwarding cleaned payload to Zapier:", cleaned);

    if (!ZAPIER_HOOK_URL) {
      console.error("⚠️ ZAPIER_HOOK_URL env var is not set");
    } else {
      await fetch(ZAPIER_HOOK_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(cleaned),
      });
    }

    res.status(200).json({ ok: true });
  } catch (err) {
    console.error("❌ Error handling Vapi webhook:", err);
    res.status(500).json({ error: "Error processing webhook" });
  }
});

app.listen(10000, () => {
  console.log("🚀 Middleware running on port 10000");
});
