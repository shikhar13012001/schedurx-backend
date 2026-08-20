// Thin wrapper around the official `twilio` SDK — the only file in this repo
// that knows Twilio's wire format, mirroring nettu-client.js's role for
// nettu-scheduler. One shared platform account (see config.js) — clinics are
// distinguished by PhoneNumberRoute, not by separate Twilio credentials.

const twilio = require("twilio");

function createTwilioClient({ accountSid, authToken, smsFrom, whatsappFrom }) {
  const client = twilio(accountSid, authToken);

  return {
    accountSid,

    // contentSid + contentVariables (an object like {"1": "...", "2": "..."})
    // send a Meta-approved Content Template instead of free text — required
    // for any business-initiated WhatsApp send outside a 24h user session
    // (see comms-workflow-service.js). body is ignored when contentSid is set.
    async sendSms({ to, from, body, contentSid, contentVariables }) {
      const payload = { to, from: from ?? smsFrom };
      if (contentSid) {
        payload.contentSid = contentSid;
        payload.contentVariables = JSON.stringify(contentVariables ?? {});
      } else {
        payload.body = body;
      }
      return client.messages.create(payload);
    },

    // `to`/`from` are plain E.164 numbers — the whatsapp: scheme prefix is an
    // implementation detail of this wrapper, not something callers should know.
    async sendWhatsApp({ to, from, body, contentSid, contentVariables }) {
      const payload = { to: `whatsapp:${to}`, from: `whatsapp:${from ?? whatsappFrom}` };
      if (contentSid) {
        payload.contentSid = contentSid;
        payload.contentVariables = JSON.stringify(contentVariables ?? {});
      } else {
        payload.body = body;
      }
      return client.messages.create(payload);
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
