const express = require("express");
const fetch = require("node-fetch");

const app = express();
app.use(express.json());

const ZAPIER_HOOK_URL = process.env.ZAPIER_HOOK_URL;

// Helper to safely dig into nested properties
const get = (obj, path, fallback = null) =>
  path.split(".").reduce((acc, key) => (acc && acc[key] !== undefined ? acc[key] : null), obj) ?? fallback;

app.post("/vapi-hook", async (req, res) => {
  console.log("===== Incoming /vapi-hook request =====");
  console.log("Body:", JSON.stringify(req.body, null, 2));
  console.log("=======================================");

  try {
    const message = req.body?.message;
    if (message?.type !== "end-of-call-report") {
      // Ignore anything else, just in case
      return res.status(200).send("ignored");
    }

    // Phone number – use best available source
    const phone =
      get(message, "customer.number") ||
      get(message, "variables.customer.number") ||
      get(message, "variableValues.customer.number") ||
      get(message, "call.customer.number") ||
      null;

    // Name – not in your payload yet, but this is where we’d look
    const name =
      get(message, "customer.name") ||
      get(message, "variables.customer.name") ||
      get(message, "variableValues.customer.name") ||
      null;

    // IP – not present in your payload. If you later pass an IP variable,
    // for example variables.clientIp, we can pull it from here.
    const ip =
      get(message, "variables.clientIp") ||
      get(message, "variableValues.clientIp") ||
      null;

    // Other useful stuff
    const callId = get(message, "call.id");
    const assistantId = get(message, "assistant.id");
    const startedAt = message.startedAt ?? null;
    const endedAt = message.endedAt ?? null;
    const endedReason = message.endedReason ?? null;

    const summary = get(message, "analysis.summary") ?? null;
    const transcript = message.transcript ?? null;

    const recordingUrl = message.recordingUrl ?? null;
    const stereoRecordingUrl = message.stereoRecordingUrl ?? null;
    const customerRecordingUrl = get(message, "recording.mono.customerUrl");
    const assistantRecordingUrl = get(message, "recording.mono.assistantUrl");

    const transport = get(message, "variables.transport") || get(message, "variableValues.transport");

    const payload = {
      phone,
      name,
      ip,
      callId,
      assistantId,
      startedAt,
      endedAt,
      endedReason,
      summary,
      transcript,
      recordingUrl,
      stereoRecordingUrl,
      customerRecordingUrl,
      assistantRecordingUrl,
      transport
    };

    console.log("Forwarding cleaned payload to Zapier:", JSON.stringify(payload, null, 2));

    if (ZAPIER_HOOK_URL) {
      await fetch(ZAPIER_HOOK_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
      });
    } else {
      console.error("Missing ZAPIER_HOOK_URL env variable");
    }

    res.status(200).send("ok");
  } catch (e) {
    console.error("Webhook Error:", e);
    res.status(200).send("ok"); // still 200 so Vapi doesn’t retry
  }
});

const PORT = process.env.PORT ?? 3000;
app.listen(PORT, () => console.log(`Middleware running on port ${PORT}`));
