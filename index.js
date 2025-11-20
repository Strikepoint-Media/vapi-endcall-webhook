// index.js
import express from 'express';
import bodyParser from 'body-parser';
import fetch from 'node-fetch';

const app = express();
app.use(bodyParser.json());

// ---------- Env vars ----------
const ZAPIER_HOOK_URL = process.env.ZAPIER_HOOK_URL;
const ABSTRACT_PHONE_API_KEY = process.env.ABSTRACT_PHONE_API_KEY;

// ---------- Helpers ----------

// Call Abstract Phone Intelligence API
async function enrichPhone(phoneNumber) {
  if (!ABSTRACT_PHONE_API_KEY || !phoneNumber) {
    console.log('Phone enrichment skipped: missing API key or phone number');
    return null;
  }

  try {
    const url = `https://phoneintelligence.abstractapi.com/v1/?api_key=${encodeURIComponent(
      ABSTRACT_PHONE_API_KEY
    )}&phone=${encodeURIComponent(phoneNumber)}`;

    const res = await fetch(url);
    const text = await res.text();

    if (!res.ok) {
      console.error('Phone enrichment HTTP error:', res.status, text);
      return null;
    }

    const data = JSON.parse(text);
    console.log('Raw phone enrichment response:', data);
    return data;
  } catch (err) {
    console.error('Phone enrichment error:', err);
    return null;
  }
}

// Map Abstract Phone Intelligence response into a compact object
function buildPhoneEnrichment(phoneEnrichmentRaw) {
  if (!phoneEnrichmentRaw || phoneEnrichmentRaw.error) return null;

  const v = phoneEnrichmentRaw.phone_validation || {};
  const c = phoneEnrichmentRaw.phone_carrier || {};
  const loc = phoneEnrichmentRaw.phone_location || {};
  const fmt = phoneEnrichmentRaw.phone_format || {};
  const msg = phoneEnrichmentRaw.phone_messaging || {};
  const risk = phoneEnrichmentRaw.phone_risk || {};

  return {
    raw: phoneEnrichmentRaw, // keep full payload if you ever want it in Zapier

    // Validation
    valid: typeof v.is_valid === 'boolean' ? v.is_valid : null,
    lineStatus: v.line_status || null,
    isVoip: typeof v.is_voip === 'boolean' ? v.is_voip : null,

    // Carrier
    carrier: c.name || null,
    lineType: c.line_type || null, // mobile / landline / voip / unknown
    mcc: c.mcc ?? null,
    mnc: c.mnc ?? null,

    // Location
    location: loc.region || loc.city || null, // “Anaheim” or “Portland”
    city: loc.city || null,
    region: loc.region || null,
    countryName: loc.country_name || null,
    countryCode: loc.country_code || null,
    countryPrefix: loc.country_prefix || null,
    timezone: loc.timezone || null,

    // Formatting
    international: fmt.international || null,
    national: fmt.national || null,

    // Messaging
    smsDomain: msg.sms_domain || null,
    smsEmail: msg.sms_email || null,

    // Risk
    riskLevel: risk.risk_level || null,
    isDisposable:
      typeof risk.is_disposable === 'boolean' ? risk.is_disposable : null,
    isAbuseDetected:
      typeof risk.is_abuse_detected === 'boolean'
        ? risk.is_abuse_detected
        : null,
  };
}

// Helper to get duration in seconds from various shapes
function getDurationSeconds(callObj, msg) {
  if (callObj && callObj.durationSeconds != null) return callObj.durationSeconds;
  if (msg && msg.durationSeconds != null) return msg.durationSeconds;
  return null;
}

function getDurationMs(callObj, msg) {
  if (callObj && callObj.durationMs != null) return callObj.durationMs;
  if (msg && msg.durationMs != null) return msg.durationMs;
  return null;
}

// ---------- Main handler ----------

async function handleVapiWebhook(req, res) {
  try {
    // Vapi wraps payload in { message: { ... } }
    const msg = req.body?.message || req.body || {};
    const artifact = msg.artifact || {};
    const analysis = msg.analysis || {};
    const variables = artifact.variables || msg.variables || {};
    const callObj = msg.call || msg;

    const eventType = msg.type || null;
    const callId = callObj.id || msg.callId || msg.id || null;

    console.log('Incoming Vapi event type:', eventType);

    // Figure out timing info
    const durationSeconds = getDurationSeconds(callObj, msg);
    const durationMs = getDurationMs(callObj, msg);
    const endedReason =
      callObj.endedReason || msg.endedReason || msg.endReason || null;

    // Decide if this is a "final" event we care about:
    //  - Normal case: end-of-call-report
    //  - Edge case: very short call that only ever sends a status-update with an endedReason
    const isEndReport = eventType === 'end-of-call-report';
    const isEarlyTerminalStatus =
      eventType === 'status-update' &&
      !!endedReason &&
      durationSeconds == null &&
      durationMs == null;

    if (!isEndReport && !isEarlyTerminalStatus) {
      console.log('Non-final event, skipping send to Zapier:', {
        eventType,
        callId,
        endedReason,
        durationSeconds,
        durationMs,
      });
      return res.json({ ok: true, skipped: true });
    }

    // ----- Core fields from Vapi -----

    // Customer phone number: look in variables, customer, call, etc.
    const customerNumber =
      variables.customer?.number ||
      variables.phoneNumber?.customerNumber ||
      msg.customer?.number ||
      callObj.customerNumber ||
      null;

    // Call info
    const callInfo = {
      id: callId,
      startedAt: callObj.startedAt || msg.startedAt || null,
      endedAt: callObj.endedAt || msg.endedAt || null,
      endedReason,
      durationSeconds,
      durationMinutes:
        durationSeconds != null
          ? Number((durationSeconds / 60).toFixed(3))
          : callObj.durationMinutes ??
            msg.durationMinutes ??
            null,
      durationMs,
      cost: callObj.cost ?? msg.cost ?? 0,
    };

    // High-level analysis
    const analysisInfo = {
      successEvaluation:
        analysis.successEvaluation ??
        msg.successEvaluation ??
        null,
      summary: msg.summary || analysis.summary || null,
    };

    // Transcript / recordings
    const transcriptInfo = {
      transcript: msg.transcript || artifact.transcript || null,
      recordingUrl: msg.recordingUrl || artifact.recordingUrl || null,
      stereoRecordingUrl:
        msg.stereoRecordingUrl || artifact.stereoRecordingUrl || null,
      logUrl: msg.logUrl || artifact.logUrl || null,
    };

    // Transport (Twilio etc.)
    const transport =
      variables.transport || msg.transport || callObj.transport || {};

    const transportInfo = {
      provider: transport.provider || null,
      conversationType: transport.conversationType || null,
      callSid: transport.callSid || null,
      accountSid: transport.accountSid || null,
    };

    // ----- Phone enrichment -----
    const phoneEnrichmentRaw = await enrichPhone(customerNumber);
    const phoneEnrichment = buildPhoneEnrichment(phoneEnrichmentRaw);

    // ----- Payload we send to Zapier -----
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
      // Uncomment this if you ever want the full Vapi message in Zapier:
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

    return res.json({ ok: true });
  } catch (err) {
    console.error('Webhook handler error:', err);
    return res.status(500).json({ error: 'Server error' });
  }
}

// ---------- Routes ----------

app.get('/', (req, res) => {
  res.send('Vapi end-of-call webhook is running');
});

// Support both "/" and "/vapi-hook" for safety
app.post('/', handleVapiWebhook);
app.post('/vapi-hook', handleVapiWebhook);

// ---------- Start server ----------

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`Middleware running on port ${PORT}`);
});
