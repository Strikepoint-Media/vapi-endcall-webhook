// index.js (CommonJS, works on Render's Node 22)

// ---------- Imports ----------
const express = require('express');
const bodyParser = require('body-parser');

// Node 18+ has global fetch
const fetch = global.fetch;

// ---------- Setup ----------
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
    const url =
      `https://phonevalidation.abstractapi.com/v1/?api_key=${ABSTRACT_PHONE_API_KEY}` +
      `&phone=${encodeURIComponent(phoneNumber)}`;

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

// Decide if we should forward a given Vapi message to Zapier
function isTerminalEvent(msg) {
  const type = msg.type;

  if (type === 'end-of-call-report') return true;

  if (type === 'status-update') {
    const status = (msg.status || '').toLowerCase();

    // Only treat terminal statuses as "one per call" events
    const terminalStatuses = [
      'completed',
      'failed',
      'no-answer',
      'busy',
      'cancelled',
      'canceled',
      'voicemail',
      'customer-ended',
      'assistant-ended',
      'ended'
    ];

    return terminalStatuses.includes(status);
  }

  return false;
}

// ---------- Routes ----------

app.get('/', (req, res) => {
  res.send('Vapi end-of-call webhook is running');
});

app.post('/', async (req, res) => {
  try {
    const msg = req.body?.message || {};
    const eventType = msg.type || 'unknown';

    console.log('Incoming Vapi message:', {
      type: eventType,
      status: msg.status,
      endedReason: msg.endedReason
    });

    // Ignore noisy intermediate status-update events
    if (!isTerminalEvent(msg)) {
      return res.json({ ok: true, ignored: true });
    }

    const artifact = msg.artifact || {};
    const analysis = msg.analysis || {};
    const variables = artifact.variables || msg.variables || {};

    // ----- Core fields -----

    // Customer phone number: try several locations
    const customerNumber =
      variables.customer?.number ||
      variables.phoneNumber?.customerNumber ||
      msg.customer?.number ||
      null;

    const callObj = msg.call || {};

    const callInfo = {
      id: callObj.id || null,
      status: msg.status || msg.endedReason || null,
      startedAt: msg.startedAt || null,
      endedAt: msg.endedAt || null,
      endedReason: msg.endedReason || null,
      durationSeconds: msg.durationSeconds ?? null,
      durationMinutes: msg.durationMinutes ?? null,
      durationMs: msg.durationMs ?? null,
      cost: msg.cost ?? null,
      costBreakdown: msg.costBreakdown || null
    };

    const analysisInfo = {
      successEvaluation: analysis.successEvaluation ?? null,
      summary: msg.summary || analysis.summary || null
    };

    const transcriptInfo = {
      transcript: msg.transcript || artifact.transcript || null,
      recordingUrl: msg.recordingUrl || artifact.recordingUrl || null,
      stereoRecordingUrl:
        msg.stereoRecordingUrl || artifact.stereoRecordingUrl || null,
      logUrl: msg.logUrl || artifact.logUrl || null
    };

    const transport =
      variables.transport || msg.transport || callObj.transport || {};

    const transportInfo = {
      provider: transport.provider || null,
      conversationType: transport.conversationType || null,
      callSid: transport.callSid || null,
      accountSid: transport.accountSid || null
    };

    // ----- Phone enrichment -----
    const phoneEnrichmentRaw = await enrichPhone(customerNumber);

    const phoneEnrichment = phoneEnrichmentRaw
      ? {
          raw: phoneEnrichmentRaw, // full payload for debugging
          valid: phoneEnrichmentRaw.valid ?? null,
          international: phoneEnrichmentRaw.format?.international || null,
          local: phoneEnrichmentRaw.format?.local || null,
          countryName: phoneEnrichmentRaw.country?.name || null,
          countryCode: phoneEnrichmentRaw.country?.code || null,
          countryPrefix: phoneEnrichmentRaw.country?.prefix || null,
          location: phoneEnrichmentRaw.location || null, // often state / region
          carrier: phoneEnrichmentRaw.carrier || null,
          lineType: phoneEnrichmentRaw.type || null // mobile / landline / voip
        }
      : null;

    // ----- Payload we send to Zapier -----
    const outgoingPayload = {
      eventType,
      call: callInfo,
      analysis: analysisInfo,
      transcript: transcriptInfo,
      customer: {
        number: customerNumber
      },
      transport: transportInfo,
      phoneEnrichment
      // If you ever want the whole blob:
      // originalMessage: msg,
    };

    console.log('Forwarding cleaned payload to Zapier:', {
      eventType,
      status: callInfo.status,
      successEvaluation: analysisInfo.successEvaluation,
      durationSeconds: callInfo.durationSeconds,
      customer: outgoingPayload.customer,
      phoneEnrichment: phoneEnrichment
        ? {
            valid: phoneEnrichment.valid,
            countryName: phoneEnrichment.countryName,
            location: phoneEnrichment.location,
            carrier: phoneEnrichment.carrier
          }
        : null
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
      body: JSON.stringify(outgoingPayload)
    });

    if (!zapRes.ok) {
      const text = await zapRes.text().catch(() => '');
      console.error('Error forwarding to Zapier:', zapRes.status, text);
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
