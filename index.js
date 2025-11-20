// index.js
import express from 'express';
import bodyParser from 'body-parser';
import fetch from 'node-fetch';

const app = express();
app.use(bodyParser.json());

// ENV VARS
const ZAPIER_HOOK_URL = process.env.ZAPIER_HOOK_URL;
// Use your Abstract *Phone Intelligence* API key here
const ABSTRACT_PHONE_API_KEY = process.env.ABSTRACT_PHONE_API_KEY; // required for enrichment

// ---------- Helpers ----------

// Enrich phone with Abstract Phone Intelligence API
async function enrichPhone(phoneNumber) {
  if (!ABSTRACT_PHONE_API_KEY || !phoneNumber) {
    console.log('Phone enrichment skipped – missing key or phone number');
    return null;
  }

  try {
    const url =
      `https://phoneintelligence.abstractapi.com/v1/` +
      `?api_key=${encodeURIComponent(ABSTRACT_PHONE_API_KEY)}` +
      `&phone=${encodeURIComponent(phoneNumber)}`;

    const res = await fetch(url);

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      console.error(
        'Phone enrichment HTTP error:',
        res.status,
        text || '(no body)'
      );
      return null;
    }

    const data = await res.json();

    // Defensive mapping – fields may vary, so we check before reading.
    return {
      raw: data, // keep full payload for debugging

      // Common fields exposed by Abstract’s phone APIs
      valid: data.valid ?? null,
      lineType: data.line_type || data.type || null, // mobile / landline / voip etc.
      carrier: data.carrier || null,
      location:
        data.location ||
        data.region ||
        data.city ||
        null, // usually state / region / city
      countryName:
        (data.country && (data.country.name || data.country.country)) || null,
      countryCode:
        (data.country && (data.country.code || data.country.iso_code)) || null,
      countryPrefix: data.country && data.country.prefix
        ? data.country.prefix
        : null,

      // Risk / flags if available
      isPrepaid: data.is_prepaid ?? null,
      isCommercial: data.is_commercial ?? null,
      riskLevel: data.risk_level || null,
    };
  } catch (err) {
    console.error('Phone enrichment error:', err);
    return null;
  }
}

// ---------- Routes ----------

app.get('/', (req, res) => {
  res.send('Vapi end-of-call webhook is running');
});

app.post('/vapi-hook', async (req, res) => {
  try {
    const msg = req.body?.message || {};
    const artifact = msg.artifact || {};
    const analysis = msg.analysis || {};
    const variables = artifact.variables || msg.variables || {};

    console.log('Incoming Vapi event type:', msg.type);

    // ----- Core fields from Vapi -----

    // Customer phone number (try a few likely locations)
    const customerNumber =
      variables.customer?.number ||
      variables.phoneNumber?.customerNumber ||
      msg.customer?.number ||
      null;

    const callInfo = {
      id: msg.call?.id,
      startedAt: msg.startedAt || null,
      endedAt: msg.endedAt || null,
      endedReason: msg.endedReason || null,
      durationSeconds: msg.durationSeconds ?? null,
      durationMinutes: msg.durationMinutes ?? null,
      durationMs: msg.durationMs ?? null,
      cost: msg.cost ?? null,
    };

    const analysisInfo = {
      successEvaluation: analysis.successEvaluation ?? null,
      score: analysis.score ?? null,
      summary: msg.summary || analysis.summary || null,
    };

    const transcriptInfo = {
      transcript: msg.transcript || artifact.transcript || null,
      recordingUrl: msg.recordingUrl || artifact.recordingUrl || null,
      stereoRecordingUrl:
        msg.stereoRecordingUrl || artifact.stereoRecordingUrl || null,
      logUrl: msg.logUrl || artifact.logUrl || null,
    };

    const transport =
      variables.transport || msg.transport || msg.call?.transport || {};

    const transportInfo = {
      provider: transport.provider || null,
      conversationType: transport.conversationType || null,
      callSid: transport.callSid || null,
      accountSid: transport.accountSid || null,
    };

    // ----- Phone enrichment via Abstract Phone Intelligence -----
    const phoneEnrichment = await enrichPhone(customerNumber);

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
      // If you ever want to see everything, uncomment the next line:
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
