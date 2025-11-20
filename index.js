app.post("/vapi-hook", async (req, res) => {
  console.log("🔔 Incoming event from Vapi");

  try {
    const message = req.body?.message || {};
    const analysis = message.analysis || {};

    // Helpful aliases
    const customer = message.customer || {};
    const phoneNumberObj = message.phoneNumber || {};
    const variables = message.variables || {};
    const transportVars = variables.transport || {};
    const call = message.call || {};
    const callTransport = call.transport || {};

    const cleaned = {
      // Core identifiers
      callId: call.id || null,
      assistantId: message.assistant?.id || null,

      // Caller info
      phone: customer.number || phoneNumberObj.number || null,

      // Timing / duration
      startedAt: message.startedAt || null,
      endedAt: message.endedAt || null,
      durationSeconds: message.durationSeconds || null,
      durationMs: message.durationMs || null,
      durationMinutes: message.durationMinutes || null,
      endedReason: message.endedReason || null,

      // Recording links
      recordingUrl: message.recordingUrl || null,
      stereoRecordingUrl: message.stereoRecordingUrl || null,

      // Cost info
      costTotal: message.cost || null,
      costBreakdown: message.costBreakdown || null,

      // Analysis / QA fields
      successEvaluation: analysis.successEvaluation || null,
      analysisSummary: analysis.summary || null,
      sentiment: analysis.sentiment || null,
      topics: analysis.topics || [],

      // Human-readable summary & transcript
      summary: message.summary || null,
      transcript: message.transcript || null,

      // Transport / Twilio info (useful for joins)
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
