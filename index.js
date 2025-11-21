// index.js – Vapi → Zapier webhook
// CommonJS, works with Render's Node runtime

const express = require('express');
const axios = require('axios');

const app = express();
app.use(express.json({ limit: '1mb' }));

// Env vars from Render
const ZAPIER_HOOK_URL = process.env.ZAPIER_HOOK_URL;

if (!ZAPIER_HOOK_URL) {
  console.warn('⚠️ ZAPIER_HOOK_URL is not set in environment variables');
}

// Simple healthcheck
app.get('/', (req, res) => {
  res.status(200).send('Vapi end-of-call webhook is live');
});

/**
 * Helper: normalize Vapi event into the shape we send to Zapier
 */
function buildCleanPayload(raw) {
  const rawType =
    raw.type ||
    raw.eventType ||
    raw.event_type ||
    null;

  const call = raw.call || {};
  const customer = raw.customer || {};
  const analysis = raw.analysis || {};
  const structuredOutputs =
    raw.structuredOutputs ||
    raw.structured_outputs ||
    null;

  return {
    eventType: rawType || 'unknown',

    call: {
      id: call.id ?? null,
      startedAt: call.startedAt ?? null,
      endedAt: call.endedAt ?? null,
      endedReason: call.endedReason ?? null,
      durationSeconds: call.durationSeconds ?? null,
      durationMinutes: call.durationMinutes ?? null,
      durationMs: call.durationMs ?? null,
      cost: call.cost ?? null
    },

    customer: {
      number: customer.number ?? null,
      name: customer.name ?? null,
      metadata: customer.metadata ?? null
    },

    phoneEnrichment: raw.phoneEnrichment || {
      valid: null,
      lineType: null,
      carrier: null,
      location: null,
      countryName: null
    },

    analysis: {
      summary: analysis.summary ?? null,
      successEvaluation: analysis.successEvaluation ?? null,
      score: analysis.score ?? null
    },

    structuredOutputs: structuredOutputs ?? null,
    rawEventType: rawType ?? null
  };
}

/**
 * Main Vapi webhook endpoint
 */
app.post('/vapi-hook', async (req, res) => {
  const raw = req.body || {};

  console.log('Incoming raw Vapi event:', JSON.stringify(raw, null, 2));

  const vapiType =
    raw.type ||
    raw.eventType ||
    raw.event_type ||
    null;

  // Only process real call lifecycle events
  const isStatusUpdate = vapiType === 'status-update';
  const isEndOfCall = vapiType === 'end-of-call-report';

  if (!isStatusUpdate && !isEndOfCall) {
    console.log(
      `Ignoring non-call event type: ${vapiType || 'unknown'} (no data forwarded to Zapier)`
    );
    return res.status(200).send('ignored');
  }

  // For status-update we only care once the call has an end reason
  if (isStatusUpdate) {
    const call = raw.call || {};
    if (!call.endedReason) {
      console.log(
        'Status-update without endedReason – mid-call update. Not forwarding to Zapier yet.'
      );
      return res.status(200).send('ignored');
    }
  }

  const cleanedPayload = buildCleanPayload(raw);

  console.log(
    'Forwarding cleaned payload to Zapier:',
    JSON.stringify(cleanedPayload, null, 2)
  );

  try {
    if (!ZAPIER_HOOK_URL) {
      console.error('❌ No ZAPIER_HOOK_URL set, cannot forward to Zapier');
    } else {
      await axios.post(ZAPIER_HOOK_URL, cleanedPayload, {
        headers: { 'Content-Type': 'application/json' }
      });
    }

    res.status(200).send('ok');
  } catch (err) {
    console.error('Error forwarding to Zapier:', err.message);
    if (err.response) {
      console.error('Zapier response data:', err.response.data);
      console.error('Zapier status:', err.response.status);
    }
    res.status(500).send('error');
  }
});

// Start server
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`Webhook server listening on port ${PORT}`);
});
