// Thin wrapper around the official `twilio` SDK — the only file in this repo
// that knows Twilio's wire format, mirroring nettu-client.js's role for
// nettu-scheduler. One shared platform account (see config.js) — clinics are
// distinguished by PhoneNumberRoute, not by separate Twilio credentials.

const twilio = require("twilio");

// statusCallbackBaseUrl + onMessageSent together wire up delivery tracking
// (see message-log-service.js) at this single choke point rather than at
// every individual call site — every send in this codebase eventually
// reaches sendSms/sendWhatsApp here, so this is where "did it actually
// deliver" gets attached once, for free, everywhere. Both are optional:
// without statusCallbackBaseUrl, Twilio has nowhere to report status to, and
// sends still work exactly as before — this is additive, not a requirement.
// sdkClient is an injection point for tests only — real callers never pass
// it, so `twilio(accountSid, authToken)` is always what actually runs in
// production. Without this, nothing could unit-test this file's own wire
// format (the payload shape sent to Twilio, the statusCallback URL, the
// onMessageSent field mapping) without a real network call — which is
// exactly why the toPhone-vs-to field mismatch and the wrong
// /status-callback route both shipped and were only caught by a live send.
function createTwilioClient({ accountSid, authToken, smsFrom, whatsappFrom, statusCallbackBaseUrl, onMessageSent, sdkClient }) {
  const client = sdkClient ?? twilio(accountSid, authToken);
  const statusCallback = statusCallbackBaseUrl ? `${statusCallbackBaseUrl}/webhooks/twilio/message-status` : undefined;

  // Fire-and-forget by design (see recordSent's own comment) — a MessageLog
  // write failing must never make the caller think the actual Twilio send
  // failed, since it didn't. The outer try/catch matters as much as the
  // .catch() — onMessageSent throwing synchronously (not returning a
  // rejected promise at all) would otherwise propagate straight out of
  // this function and fail the send that already genuinely succeeded.
  function logSent(result, { channel, to, clinicId, purpose }) {
    if (!onMessageSent) return;
    try {
      Promise.resolve(onMessageSent({ sid: result.sid, channel, toPhone: to, clinicId, purpose, initialStatus: result.status })).catch(() => {});
    } catch {
      // Swallowed for the same reason as the .catch() above.
    }
  }

  return {
    accountSid,

    // contentSid + contentVariables (an object like {"1": "...", "2": "..."})
    // send a Meta-approved Content Template instead of free text — required
    // for any business-initiated WhatsApp send outside a 24h user session
    // (see comms-workflow-service.js). body is ignored when contentSid is set.
    // clinicId/purpose are optional context for delivery-status logging
    // only — never sent to Twilio.
    async sendSms({ to, from, body, contentSid, contentVariables, clinicId, purpose }) {
      const payload = { to, from: from ?? smsFrom };
      if (contentSid) {
        payload.contentSid = contentSid;
        payload.contentVariables = JSON.stringify(contentVariables ?? {});
      } else {
        payload.body = body;
      }
      if (statusCallback) payload.statusCallback = statusCallback;
      const result = await client.messages.create(payload);
      logSent(result, { channel: "sms", to, clinicId, purpose });
      return result;
    },

    // `to`/`from` are plain E.164 numbers — the whatsapp: scheme prefix is an
    // implementation detail of this wrapper, not something callers should know.
    async sendWhatsApp({ to, from, body, contentSid, contentVariables, clinicId, purpose }) {
      const payload = { to: `whatsapp:${to}`, from: `whatsapp:${from ?? whatsappFrom}` };
      if (contentSid) {
        payload.contentSid = contentSid;
        payload.contentVariables = JSON.stringify(contentVariables ?? {});
      } else {
        payload.body = body;
      }
      if (statusCallback) payload.statusCallback = statusCallback;
      const result = await client.messages.create(payload);
      logSent(result, { channel: "whatsapp", to, clinicId, purpose });
      return result;
    },

    // `url` must be the exact public URL Twilio computed the signature
    // against (scheme + host + path + query, no trailing-slash surprises) —
    // see webhooks-twilio.js for how it's reconstructed from the request.
    validateSignature(signatureHeader, url, params) {
      return twilio.validateRequest(authToken, signatureHeader ?? "", url, params ?? {});
    },

    VoiceResponse: twilio.twiml.VoiceResponse,
    MessagingResponse: twilio.twiml.MessagingResponse,
  };
}

module.exports = { createTwilioClient };
