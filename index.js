// index.js
// Webhook for Vapi -> Render -> Zapier with phone enrichment via Abstract

const express = require('express');
const axios = require('axios');

const app = express();
app.use(express.json());

// Env vars from Render
const PORT = process.env.PORT || 10000;
const ABSTRACT_PHONE_API_KEY = process.env.ABSTRACT_PHONE_API_KEY;
const ZAPIER_HOOK_URL = process.env.ZAPIER_HOOK_URL;

// Simple in-memory set to de-dupe final events per call
if (!global.processedCalls) {
  global.processedCalls = new Set();
}

/**
 * Call Abstract Phone Intelligence API for enrichment
 * Docs: https://www.abstractapi.com/api/phone-intelligence-api
 */
async function enrichPhoneNumber(phoneNumber) {
  if (!ABSTRACT_PHONE_API_KEY || !phoneNumber) {
    return null;
  }

  try {
    const response = await axios.get('https://phoneintelligence.abstractapi.com/v1/', {
      params: {
        api_key: ABSTRACT_PHONE_API_KEY,
        phone: phoneNumber
      },
      timeout: 8000
    });

    const data = response.data || {};
    console.log('Raw phone enrichment response:', JSON.stringify(data, null, 2));

    const loc = data.phone_location || {};
    const carrier = data.phone_carrier || {};
    const validation = data.phone_validation || {};

    return {
      valid: validation.is_valid ?? null,
      lineType: carrier.line_type ?? null,
      carrier: carrier.name ?? null,
      location: loc.city && loc.region
        ? `${loc.city}, ${loc.region}`
        : loc.city || loc.region || null,
      countryName: loc.country_name ?? null
    };
  } catch (err) {
    console.error('Phone enrichment HTTP error:', err.response?.data || err.message);
    return null;
  }
}

/**
 * Compute Identity & Contact Validation score (0–70)
 * Based on:
 *  - Call duration
 *  - Ended reason
 *  - Qualitative label from success evaluation (if present)
 */
function computeIdentityScore({ call, successLabel }) {
  const duration = Number(call.durationSeconds || 0);
  const endedReason = (call.endedReason || '').toLowerCase();

  // Very bad / unreachable: invalid, disconnected, spammy or essentially no conversation
  const badReasons = [
    'invalid-number',
    'invalid_number',
    'disconnected',
    'failed',
    'customer-did-not-answer',
    'customer did not answer',
    'busy',
    'wrong-number',
    'wrong number',
    'voicemail'
  ];

  if (badReasons.some(r => endedReason.includes(r))) {
    return 0;
  }

  // If it was < 5 seconds, treat as no meaningful engagement
  if (duration < 5) {
    return 0;
  }

  // "Engaged": actually spoke for a bit
  const engaged = duration >= 30;
  const label = (successLabel || '').toLowerCase();

  // Great engagement: long enough + strong qualitative label
  if (
    engaged &&
    (label === 'excellent' || label === 'good')
  ) {
    return 70;
  }

  // Otherwise: answered but not fully engaged
  return 50;
}

// Simple health check
app.get('/', (req, res) => {
  res.send('Vapi end-of-call webhook is live');
});

app.post('/vapi-hook', async (req, res) => {
  const event = req.body || {};
  const eventType = event.type;

  console.log('Incoming Vapi event type:', eventType);

  // Only process the relevant event types
  if (eventType !== 'status-update' && eventType !== 'end-of-call-report') {
    return res.status(200).json({ ok: true, ignored: true });
  }

  const call = event.call || {};
  const customer = event.customer || {};
  const analysis = event.analysis || {};
  const structuredOutputs =
    event.structuredOutputs || analysis.structuredOutputs || {};

  const callId = call.id || event.callId || 'unknown-call-id';
  const hasEndedReason = !!call.endedReason;

  // Basic de-dupe so we only send one "final" payload per call
  if (hasEndedReason && global.processedCalls.has(callId)) {
    console.log('Already processed final event for call:', callId);
    return res.status(200).json({ ok: true, deduped: true });
  }

  // Decide if we should forward this event to Zapier
  const shouldForward =
    eventType === 'end-of-call-report' ||
    (eventType === 'status-update' && hasEndedReason);

  if (!shouldForward) {
    console.log('Not forwarding intermediate event for call:', callId);
    return res.status(200).json({ ok: true, skipped: true });
  }

  if (hasEndedReason) {
    global.processedCalls.add(callId);
  }

  // Phone enrichment
  const phoneEnrichment = await enrichPhoneNumber(customer.number || null);

  // Try to pull a descriptive label from structured outputs (if configured in Vapi)
  const successEvaluationLabel =
    structuredOutputs?.successEvaluationLabel ||
    structuredOutputs?.['Success Evaluation - Descriptive'] ||
    null;

  // Compute identity/contact validation score
  const identityValidationScore = computeIdentityScore({
    call,
    successLabel: successEvaluationLabel
  });

  // Build cleaned payload for Zapier
  const cleanedPayload = {
    eventType,
    call: {
      id: callId,
      startedAt: call.startedAt || null,
      endedAt: call.endedAt || null,
      endedReason: call.endedReason || null,
      durationSeconds: call.durationSeconds ?? null,
      durationMinutes: call.durationMinutes ?? null,
      durationMs: call.durationMs ?? null,
      cost: call.cost ?? 0
    },
    customer: {
      number: customer.number || null
    },
    phoneEnrichment,
    successEvaluation: analysis.successEvaluation ?? null,
    successEvaluationScore: event.score ?? null,
    successEvaluationLabel,
    identityValidationScore,
    // Pass through any structured outputs + metadata in case you want them in Zapier
    structuredOutputs,
    metadata: event.metadata || null
  };

  console.log(
    'Forwarding cleaned payload to Zapier for call:',
    callId,
    JSON.stringify(cleanedPayload, null, 2)
  );

  // Forward to Zapier
  if (!ZAPIER_HOOK_URL) {
    console.error('ZAPIER_HOOK_URL is not set – skipping Zapier POST');
  } else {
    try {
      await axios.post(ZAPIER_HOOK_URL, cleanedPayload, {
        headers: { 'Content-Type': 'application/json' }
      });
      console.log('Successfully forwarded to Zapier for call:', callId);
    } catch (err) {
      console.error(
        'Error forwarding to Zapier for call:',
        callId,
        err.response?.data || err.message
      );
    }
  }

  res.status(200).json({ ok: true });
});

app.listen(PORT, () => {
  console.log(`Middleware service running on port ${PORT}`);
});
