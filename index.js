import express from "express";
import fetch from "node-fetch";
import bodyParser from "body-parser";
import dotenv from "dotenv";

dotenv.config();
const app = express();

app.use(bodyParser.json());

// Zapier webhook URL stored as an environment variable in Render
const ZAPIER_WEBHOOK = process.env.ZAPIER_WEBHOOK_URL;

app.post("/", async (req, res) => {
  console.log("🔔 Incoming event from Vapi");

  try {
    const data = req.body || {};
    const payload = data.payload || {};

    // Extract useful fields safely
    const cleaned = {
      callId: payload.call?.id ?? null,
      assistantId: payload.assistantId ?? null,

      // Caller info
      phoneNumber: payload.info?.phoneNumber ?? null,
      ipAddress: payload.info?.ipAddress ?? null,

      // Duration + start/end timestamps
      startTime: payload.startTime ?? null,
      endTime: payload.endTime ?? null,
      duration: payload.duration ?? null, // seconds or ms depending on Vapi config

      // Call outcome
      endedReason: payload.endedReason ?? null,

      // Analysis
      successEvaluation: payload.analysis?.successEvaluation ?? null,
      sentiment: payload.analysis?.sentiment ?? null,
      topics: payload.analysis?.topics ?? [],
      summary: payload.analysis?.summary ?? null,
    };

    console.log("📦 Cleaned Payload:", cleaned);

    // Forward to Zapier
    if (ZAPIER_WEBHOOK) {
      await fetch(ZAPIER_WEBHOOK, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(cleaned),
      });

      console.log("📨 Forwarded cleaned payload to Zapier");
    } else {
      console.error("⚠️ ZAPIER_WEBHOOK_URL not set in environment variables");
    }

    res.status(200).send({ ok: true });
  } catch (err) {
    console.error("❌ Error handling Vapi webhook:", err);
    res.status(500).send({ error: "Error processing webhook" });
  }
});

app.listen(10000, () => {
  console.log("🚀 Middleware running on port 10000");
});
