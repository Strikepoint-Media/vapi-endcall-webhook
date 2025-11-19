const express = require("express");
const fetch = require("node-fetch");

const app = express();
app.use(express.json());

const https://hooks.zapier.com/hooks/catch/122973/uzuhqhs/ = process.env.https://hooks.zapier.com/hooks/catch/122973/uzuhqhs/;

app.post("/vapi-hook", async (req, res) => {
  try {
    const message = req.body?.message;
    if (message?.type === "end-of-call-report") {
      const call = message.call ?? {};
      const artifact = message.artifact ?? {};
      const customer = call.customer ?? {};
      const metadata = call.metadata ?? {};

      const phone =
        customer.number ??
        call.to?.number ??
        call.from?.number ??
        null;

      const name =
        customer.name ??
        metadata.name ??
        null;

      const ip =
        metadata.ip ?? null;

      const payload = {
        phone,
        name,
        ip,
        callId: call.id ?? null,
        endedReason: message.endedReason ?? null,
        startedAt: call.startedAt ?? null,
        endedAt: call.endedAt ?? null,
        transcript: artifact.transcript ?? null
      };

      if (ZAPIER_HOOK_URL) {
        await fetch(ZAPIER_HOOK_URL, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload)
        });
      } else {
        console.error("Missing ZAPIER_HOOK_URL env variable");
      }
    }

    res.status(200).send("ok");
  } catch (e) {
    console.error("Webhook Error:", e);
    res.status(200).send("ok");
  }
});

const PORT = process.env.PORT ?? 3000;
app.listen(PORT, () => console.log(`Middleware running on port ${PORT}`));