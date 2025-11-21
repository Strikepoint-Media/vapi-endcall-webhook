// index.js  (ESM-compatible)
// Node 18+ (Render is on Node 22, so you're good)

import express from 'express';

// Read environment variables
const PORT = process.env.PORT || 10000;
const ZAPIER_HOOK_URL = process.env.ZAPIER_HOOK_URL;
const ABSTRACT_PHONE_API_KEY = process.env.ABSTRACT_PHONE_API_KEY;

if (!ZAPIER_HOOK_URL) {
  console.warn('⚠️ ZAPIER_HOOK_URL is not set. Events will not be forwarded to Zapier.');
}
if (!ABSTRACT_PHONE_API_KEY) {
  console.warn('⚠️ ABSTRACT_PHONE_API_KEY is not set. Phone enrichment will be skipped.');
}

const app = express();
app.use(express.json({ limit: '1mb' }));

/**
 * Helper: call Abstract Phone Intelligence API
 */
async function enrichPhoneNumber(phoneNumber) {
  if (!ABSTRACT_PHONE_API_KEY || !phoneNumber) return null;

  try {
    const url = `https://phoneintelligence.abstractapi.com/v1/?api_key=${encodeURIComponent(
      ABSTRACT_PHONE_API_KEY
    )}&phone=${encodeURIComponent(phoneNumber)}`;

    const response = await fetch(url);
    if (!response.ok) {
      const text = await response.text();
      console.error('❌ Phone enrichment HTTP error:', response.status, text);
      return null;
    }

    const data = await response.json();

    // Log raw response for debugging
    console.log('Raw phone enrichment response:', data);

    return {
      valid: data.phone_validation?.is_valid ?? null,
      lineType: data.phone_carrier?.line_type ?? null,
      carrier: data.phone_carrier?.name ?? null,
      location: data.phone_location?.city ?? null,
      region: data.phone_location?.region ?? null,
      countryName: data.phone_location?.country_name ?? null,
      timezone: data.phone_location?.timezone ?? null,
    };
  } catch (err) {
    console.error('❌ Error calling phone enrichment API:', err);
    return null;
  }
}

/**
 * Helper: forward cleaned payload to Zapier
 */
async function forwardToZapier(payload) {
  if (!ZAPIER_HOOK_URL) {
    console.warn('⚠️ ZAPIER_HOOK_URL not configured. Skipping Zapier forward.');
    return;
  }

  try {
    console.log('Forwarding cleaned payload to Zapier:', payload);

    const res = await fetch(ZAPIER_HOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });

    if (!res.ok) {
      const text = await res.text();
      console.error('❌ Zapier HTTP error:', res.status, text);
    }
  } catch (err) {
    console.error('❌ Error forwarding to Zapier:', err);
  }
}

/**
 * Main webhook endpoint for Vapi
 */
app.post('/vapi-hook', async (req, res) => {
  const event = req.body || {};
  console.log('Incoming Vapi event:', JSON.stringify(event, null, 2));

  // Vapi usually uses "type" for the event name
  const eventType = event.type || event.eventType || 'unknown';

  const call = event.call || {};
  const customer = event.customer || {};
  const analysis = event.analysis || {};
  const structuredOutputs =
    event.structuredOutputs || event.structured_outputs || null;

  const phoneNumber =
    customer.number || customer.phoneNumber || customer.phone || null;

  // Always attempt enrichment if possible
  let phoneEnrichment = event.phoneEnrichment || event.phone_enrichment || null;
  if (!phoneEnrichment && phoneNumber) {
    phoneEnrichment = await enrichPhoneNumber(phoneNumber);
  }

  // Normalize call timing data
  const durationMs = call.durationMs ?? null;
  const durationSeconds =
    call.durationSeconds ??
    (typeof durationMs === 'number' ? durationMs / 1000 : null);
  const durationMinutes =
    call.durationMinutes ??
    (typeof durationMs === 'number'
      ? Number((durationMs / 60000).toFixed(3))
      : null);

  const cleanedPayload = {
    eventType, // e.g. "status-update", "end-of-call-report"
    call: {
      id: call.id ?? null,
      startedAt: call.startedAt ?? null,
      endedAt: call.endedAt ?? null,
      endedReason: call.endedReason ?? call.ended_reason ?? null,
      durationSeconds,
      durationMinutes,
      durationMs,
      cost: call.cost ?? null,
    },
    customer: {
      number: phoneNumber,
      name: customer.name ?? null,
      metadata: customer.metadata ?? null,
    },
    phoneEnrichment: phoneEnrichment || {
      valid: null,
      lineType: null,
      carrier: null,
      location: null,
      region: null,
      countryName: null,
      timezone: null,
    },
    analysis: {
      // These come from Vapi’s Summary + Success Evaluation / Rubric
      summary: analysis.summary ?? null,
      successEvaluation: analysis.successEvaluation ?? null,
      score: analysis.score ?? null,
    },
    structuredOutputs, // full blob of any structured outputs you configured
    rawEventType: event.type || null, // keep original for debugging
  };

  // Forward everything to Zapier
  await forwardToZapier(cleanedPayload);

  // Respond to Vapi
  res.status(200).json({ ok: true });
});

/**
 * Health check / root
 */
app.get('/', (_req, res) => {
  res.status(200).send('Vapi end-of-call webhook is running.');
});

app.listen(PORT, () => {
  console.log(`Middleware server running on port ${PORT}`);
  console.log('=> Your service is live 🎉');
});
