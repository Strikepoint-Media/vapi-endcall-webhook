// index.js
import express from 'express';
import bodyParser from 'body-parser';
import fetch from 'node-fetch';

const app = express();
app.use(bodyParser.json());

// ---------- ENV VARS ----------
const ZAPIER_HOOK_URL = process.env.ZAPIER_HOOK_URL;
const ABSTRACT_PHONE_API_KEY = process.env.ABSTRACT_PHONE_API_KEY; // Phone Intelligence API key

// ---------- Helpers ----------

// Enrich phone using Abstract Phone Intelligence API
async function enrichPhone(phoneNumber) {
  if (!ABSTRACT_PHONE_API_KEY || !phoneNumber) return null;

  try {
    const url = `https://phoneintelligence.abstractapi.com/v1/?api_key=${encodeURIComponent(
      ABSTRACT_PHONE_API_KEY
    )}&phone=${encodeURIComponent(phoneNumber)}`;

    const res = await fetch(url);

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      console.error('Phone enrichment HTTP error:', res.status, text);
      return null;
    }

    const data = await res.json();

    // Log once so you can see the raw shape in Render logs
    console.log('Raw phone enrichment response:', data);

    return data;
  } catch (err) {
    console.error('Phone enrichment error:', err);
    return null;
  }
}

// Normalize different field names that Abstract might use
function normalizePhoneEnrichment(raw) {
  if (!raw) return null;

  const valid =
    raw.valid ??
    raw.is_valid_number ??
    raw.is_valid ??
    null;

  const lineType =
    raw.type ??
    raw.line_type ??
    null;

  const carrier =
    raw.carrier ??
    raw.carrier_name ??
    null;

  const location =
    raw.location ??
    raw.region ??
    raw.city ??
    null;

  const countryName =
    raw.country?.name ??
    raw.country_name ??
    null;

  return {
    valid,
    lineType,
    carrier,
    location,
    countryName,
    raw, // keep full payload for debugging / Zapier mapping if needed
  };
}

// ---------- Routes ----------

app.get('/', (req, res) => {
  res.send('Vapi end-of-call webhook is running');
});

// Vapi points to: https://vapi-endcall-webhook-new.onrender.com/vapi-hook
app.post('/vapi-hook', async (req, res) => {
  try {
    // Some Vapi payloads wrap in { message: {...} }
    const msg = req.body?.message || req.body || {};
    const artifact = msg.artifact || {};
    const analysis = msg.analysis || {};
    const variables = artifact.variables || msg.variables || {};

    console.log('Incoming Vapi event type:', msg.type);

    // ----- Core fields from Vapi -----
    const customerNumber =
      variables.customer?.number ||
      variables.phoneNumber?.customerNumber ||
      msg.customer?.number ||
      null;

    const call = msg.call || {};

    const callInfo = {
      id: call.id || msg.callId || null,
      startedAt: msg.startedAt || call.startedAt || null,
      endedAt: msg.endedAt || call.endedAt || null,
      endedReason: msg.endedReason || call.endedReason || null,
      durationSeconds:
        msg.durationSeconds ?? call.durationSeconds ?? null,
      durationMinutes:
        msg.durationMinutes ?? call.durationMinutes ?? null,
      durationMs:
        msg.durationMs ?? call.durationMs ?? null,
      cost: msg.cost ?? call.cost ?? null,
    };

    const analysisInfo = {
      successEvaluation:
        analysis.successEvaluation ??
        msg.successEvaluation ??
        null,
      summary:
        msg.summary ??
        analysis.summary ??
        null,
    };

    const transcriptInfo = {
      transcript:
        msg.transcript ??
        artifact.transcript ??
        null,
      recordingUrl:
        msg.recordingUrl ??
        artifact.recordingUrl ??
        null,
      stereoRecordingUrl:
        msg.stereoRecordingUrl ??
        artifact.stereoRecordingUrl ??
        null,
      logUrl:
        msg.logUrl ??
        artifact.logUrl ??
        null,
    };

    const transport =
      variables.transport ||
      msg.transport ||
      call.transport ||
      {};

    const transportInfo = {
      provider: transport.provider || null,
      conversationType: transport.conversationType || null,
      callSid: transport.callSid || null,
      accountSid: transport.accountSid || null,
    };

    // ----- Phone enrichment -----
    const phoneEnrichmentRaw = await enrichPhone(customerNumber);
    const phoneEnrichment = normalizePhoneEnrichment(phoneEnrichmentRaw);

    // ----- Payload to Zapier -----
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
      // Uncomment if you ever want the entire payload
      // originalMessage: msg,
    };

    console.log('Forwarding cleaned payload to Zapier:', {
      eventType: outgoingPayload.eventType,
      call: outgoingPayload.call,
      customer: outgoingPayload.customer,
      phoneEnrichment: phoneEnrichment
        ? {
            valid: phoneEnrichment.valid,
            lineType: phoneEnrichment.lineType,
            carrier: phoneEnrichment.carrier,
            location: phoneEnrichment.location,
            countryName: phoneEnrichment.countryName,
          }
        : null,
    });

    if (!ZAPIER_HOOK_URL) {
      console.error('ZAPIER_HOOK_URL is not set');
      return res
        .status(500)
        .json({ error: 'ZAPIER_HOOK_URL is not configured' });
    }

    const zapRes = await fetch(ZAPIER_HOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(outgoingPayload),
    });

    if (!zapRes.ok) {
      const text = await zapRes.text().catch(() => '');
      console.error(
        'Error forwarding to Zapier:',
        zapRes.status,
        text
      );
    }

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
