// index.js (ESM)

import express from 'express';
import bodyParser from 'body-parser';
import fetch from 'node-fetch';

const app = express();
app.use(bodyParser.json());

// ----------------- ENV VARS -----------------

const ZAPIER_HOOK_URL = process.env.ZAPIER_HOOK_URL;
const ABSTRACT_PHONE_API_KEY = process.env.ABSTRACT_PHONE_API_KEY; // optional

// ----------------- Helpers ------------------

// Phone enrichment using Abstract Phone Validation API
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

// ----------------- Routes -------------------

// Simple health-check
app.get('/vapi-hook', (req, res) => {
  res.send('Vapi webhook is running');
});

// Main Vapi webhook endpoint
app.post('/vapi-hook', async (req, res) => {
  try {
    const outer = req.body || {};
    const msg = outer.message || {}; // Vapi wraps the actual message
    const artifact = msg.artifact || {};
    const analysis = msg.analysis || {};
    const variables =
      artifact.variables || msg.variables || msg.variableValues || {};

    const eventType = msg.type || outer.type || null;
    console.log('Incoming Vapi event type:', eventType);

    // ------------- Core call info -------------

    // Customer phone number
    const customerNumber =
      variables.customer?.number ||
      variables.phoneNumber?.customerNumber ||
      outer.customer?.number ||
      msg.customer?.number ||
      null;

    const call = msg.call || outer.call || {};
    const callInfo = {
      id: call.id || null,
      type: call.type || null,
      startedAt: msg.startedAt || outer.startedAt || null,
      endedAt: msg.endedAt || outer.endedAt || null,
      endedReason: msg.endedReason || outer.endedReason || null,
      durationMs: msg.durationMs ?? outer.durationMs ?? null,
      durationSeconds: msg.durationSeconds ?? outer.durationSeconds ?? null,
      durationMinutes: msg.durationMinutes ?? outer.durationMinutes ?? null,
      cost: msg.cost ?? outer.cost ?? null,
    };

    // ------------- Analysis info -------------

    const analysisInfo = {
      successEvaluation:
        analysis.successEvaluation ?? msg.successEvaluation ?? null,
      summary: msg.summary || analysis.summary || null,
    };

    // ------------- Transcript / recordings -------------

    const transcriptInfo = {
      transcript: msg.transcript || artifact.transcript || null,
      recordingUrl:
        msg.recordingUrl || artifact.recordingUrl || outer.recordingUrl || null,
      stereoRecordingUrl:
        msg.stereoRecordingUrl ||
        artifact.stereoRecordingUrl ||
        outer.stereoRecordingUrl ||
        null,
      logUrl: msg.logUrl || artifact.logUrl || outer.logUrl || null,
    };

    // ------------- Transport (Twilio etc.) -------------

    const transport =
      variables.transport || msg.transport || call.transport || outer.transport || {};
    const transportInfo = {
      provider: transport.provider || null,
      conversationType: transport.conversationType || null,
      callSid: transport.callSid || null,
      accountSid: transport.accountSid || null,
    };

    // ------------- Phone enrichment -------------

    const phoneEnrichmentRaw = await enrichPhone(customerNumber);

    const phoneEnrichment = phoneEnrichmentRaw
      ? {
          raw: phoneEnrichmentRaw, // keep full payload if you want to debug in Zapier
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

    // ------------- Decide what to forward -------------

    // For now: forward BOTH end-of-call-report and status-update
    // You can filter in Zapier on `eventType`.
    const shouldForward =
      eventType === 'end-of-call-report' || eventType === 'status-update';

    if (!shouldForward) {
      console.log('Ignoring Vapi event type:', eventType);
      return res.json({ ok: true, ignored: true });
    }

    const outgoingPayload = {
      eventType,
      call: callInfo,
      analysis: analysisInfo,
      transcript: transcriptInfo,
      customer: {
        number: customerNumber,
      },
      transport: transportInfo,
      phoneEnrichment,
      // If you want raw debugging, uncomment this:
      // originalMessage: outer,
    };

    console.log('Forwarding to Zapier:', {
      eventType,
      call: outgoingPayload.call,
      successEvaluation: outgoingPayload.analysis.successEvaluation,
      customer: outgoingPayload.customer,
      phoneSummary: phoneEnrichment
        ? {
            valid: phoneEnrichment.valid,
            location: phoneEnrichment.location,
            carrier: phoneEnrichment.carrier,
          }
        : null,
    });

    if (!ZAPIER_HOOK_URL) {
      console.error('ZAPIER_HOOK_URL is not set');
      return res
        .status(500)
        .json({ error: 'ZAPIER_HOOK_URL is not configured on the server' });
    }

    const zapRes = await fetch(ZAPIER_HOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(outgoingPayload),
    });

    if (!zapRes.ok) {
      const text = await zapRes.text().catch(() => '');
      console.error('Error forwarding to Zapier:', zapRes.status, text);
    }

    // Always respond to Vapi so it doesn’t retry forever
    res.json({ ok: true });
  } catch (err) {
    console.error('Webhook handler error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// ----------------- Start server -----------------

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`Middleware running on port ${PORT}`);
});
