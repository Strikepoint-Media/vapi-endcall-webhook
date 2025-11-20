// simple in-memory tracker to avoid double-sending per call
const sentCalls = new Set();

app.post('/', async (req, res) => {
  const { message } = req.body || {};
  if (!message) return res.status(200).json({ ok: true });

  const type = message.type;

  // 1) Preferred: rich end-of-call report
  if (type === 'end-of-call-report') {
    const callId = message.call?.id ?? null;
    if (callId && sentCalls.has(callId)) {
      // we already sent this call from a status-update fallback
      return res.status(200).json({ ok: true });
    }

    const cleaned = {
      source: 'end-of-call-report',
      callId,
      assistantName: message.assistant?.name ?? null,
      assistantPhone: message.phoneNumber?.number ?? null,
      customerPhone:
        message.customer?.number ??
        message.variables?.customer?.number ??
        message.variableValues?.customer?.number ??
        null,
      endedReason: message.endedReason ?? null,
      durationSeconds: message.durationSeconds ?? null,
      successEvaluation:
        message.analysis?.successEvaluation ??
        message.successEvaluation ??
        null,
      callSummary:
        message.analysis?.summary ??
        message.summary ??
        null,
      transcript: message.transcript ?? null,
      // plus your phone/IP enrichment fields here
    };

    await sendToZapier(cleaned);
    if (callId) sentCalls.add(callId);
    return res.status(200).json({ ok: true });
  }

  // 2) Fallback: status-update, only when the call is ended
  if (type === 'status-update') {
    const status = message.status;
    if (status !== 'ended') {
      // ignore started/ringing/in-progress, etc.
      return res.status(200).json({ ok: true });
    }

    const callId = message.call?.id ?? null;
    if (callId && sentCalls.has(callId)) {
      // we already sent something for this call
      return res.status(200).json({ ok: true });
    }

    const fallback = {
      source: 'status-update',
      callId,
      assistantName: message.assistant?.name ?? null,
      assistantPhone: message.phoneNumber?.number ?? null,
      customerPhone:
        message.customer?.number ??
        message.variables?.customer?.number ??
        null,
      endedReason: message.endedReason ?? status ?? null,
      durationSeconds: message.durationSeconds ?? null,
      successEvaluation: false, // your own "this was not a full success" flag
      callSummary: null,
      transcript: null,
      // phone/IP enrichment can still go here if you want
    };

    await sendToZapier(fallback);
    if (callId) sentCalls.add(callId);
    return res.status(200).json({ ok: true });
  }

  // Ignore any other message types
  return res.status(200).json({ ok: true });
});
