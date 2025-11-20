// index.js
import express from 'express';
import bodyParser from 'body-parser';
import fetch from 'node-fetch';

const app = express();
app.use(bodyParser.json());

// ENV VARS
const ZAPIER_HOOK_URL = process.env.ZAPIER_HOOK_URL;
const ABSTRACT_PHONE_API_KEY = process.env.ABSTRACT_PHONE_API_KEY; // optional

// ---------- Helpers ----------

// Enrich phone with Abstract Phone Validation API
async function enrichPhone(phoneNumber) {
  if (!ABSTRACT_PHONE_API_KEY || !phoneNumber) return null;

  try {
    const url = `https://phonevalidation.abstractapi.com/v1/?api_key=${ABSTRACT_PHONE_API_KEY}&phone=${encodeURIComponent(
      phoneNumber
    )}`;

    const res = await fetch(url);
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      console.error('Phone enrichment HTTP error:', res.status, text);
      return null;
    }

    const data = await res.json();
    return data;
  } catch (err) {
    console.error('Phone enrichment error:', err);
    return null;
  }
}

// ---------- Routes ----------

app.get('/', (req, res) => {
  res.send('Vapi end-of-call webhook is running');
});

app.post('/', async (req, res) => {
  try {
    // Vapi server event payload (what you pasted from webhook.site)
    const msg = req.body?.message || {};
    const artifact = msg.artifact || {};
    const analysis = msg.analysis || {};
    const variables = artifact.variables || msg.variables || {};

    console.log('Incoming Vapi message type:', msg.type);

    // ----- Core fields from Vapi -----

    // Phone number (from variables or top-level customer)
    const customerNumber =
      variables.customer?.number ||
      variables.phoneNumber?.customerNumber ||
      msg.customer?.number ||
      null;

    // Call timing + reason (already computed by Vapi)
    const callInfo = {
      id: msg.call?.id,
      startedAt: msg.startedAt || null,
      endedAt: msg.endedAt || null,
      endedReason: msg.endedReason || null,
      durationSeconds: msg.durationSeconds ?? null,
      durationMinutes: msg.durationMinutes ?? null,
      durationMs: msg.durationMs ?? null,
    };

    // High-level analysis
    const analysisInfo = {
      successEvaluation: analysis.successEvaluation ?? null,
      summary: msg.summary || analysis.summary || null,
    };

    // Transcript + recordings
    const transcriptInfo = {
      transcript: msg.transcript || artifact.transcript || null,
      recordingUrl: msg.recordingUrl || artifact.recordingUrl || null,
      stereoRecordingUrl:
        msg.stereoRecordingUrl || artifact.stereoRecordingUrl || null,
      logUrl: msg.logUrl || artifact.logUrl || null,
    };

    // Transport (Twilio call SID etc.)
    const transport =
      variables.transport || msg.transport || msg.call?.transport || {};

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
          raw: phoneEnrichmentRaw, // full payload for debugging / optional
          valid: phoneEnrichmentRaw.valid ?? null,
          international: phoneEnrichmentRaw.format?.international || null,
          local: phoneEnrichmentRaw.format?.local || null,
          countryName: phoneEnrichmentRaw.country?.name || null,
          countryCode: phoneEnrichmentRaw.country?.code || null,
          countryPrefix: phoneEnrichmentRaw.country?.prefix || null,
          location: phoneEnrichmentRaw.location || null, // often state / region
          carrier: phoneEnrichmentRaw.carrier || null,
          lineType: phoneEnrichmentRaw.type || null, // mobile / landline / voip
        }
      : null;

    // ----- Payload we send to Zapier -----
    const outgoingPayload = {
      // minimal but structured object – easy to map in Zapier
      eventType: msg.type || null,
      call: callInfo,
      analysis: analysisInfo,
      transcript: transcriptInfo,
      customer: {
        number: customerNumber,
      },
      transport: transportInfo,
      phoneEnrichment,
      // Optional: keep the full original for debugging if you want
      // originalMessage: msg,
    };

    console.log('Forwarding cleaned payload to Zapier:', {
      eventType: outgoingPayload.eventType,
      call: outgoingPayload.call,
      customer: outgoingPayload.customer,
      phoneEnrichment: phoneEnrichment
        ? {
            valid: phoneEnrichment.valid,
            countryName: phoneEnrichment.countryName,
            location: phoneEnrichment.location,
            carrier: phoneEnrichment.carrier,
          }
        : null,
    });

    if (!ZAPIER_HOOK_URL) {
      console.error('ZAPIER_HOOK_URL is not set');
      return res.status(500).json({ error: 'ZAPIER_HOOK_URL is not configured' });
    }

    // Send to Zapier
    const zapRes = await fetch(ZAPIER_HOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(outgoingPayload),
    });

    if (!zapRes.ok) {
      const text = await zapRes.text().catch(() => '');
      console.error('Error forwarding to Zapier:', zapRes.status, text);
    }

    // Always tell Vapi we handled the webhook
    res.json({ ok: true });
  } catch (err) {
    console.error('Webhook handler error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// ---------- Start server ----------

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`Middleware running on port ${PORT}`);
});
