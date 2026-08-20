// Shaped like createTwilioClient()'s return value (twilio-client.js) — just
// the sendSms/sendWhatsApp/validateSignature/VoiceResponse surface this
// project's code actually calls. VoiceResponse is the real twilio package's
// TwiML builder (pure XML string-building, no network call, safe to use as-is
// in tests) — only the network-calling pieces are faked.
const { twiml } = require("twilio");

function createTwilioStub({ shouldRejectSignature = false, sendResult = null, shouldFailSend = false } = {}) {
  const calls = { sendSms: [], sendWhatsApp: [] };
  return {
    calls,
    async sendSms(opts) {
      calls.sendSms.push(opts);
      if (shouldFailSend) throw new Error("Twilio send failed");
      return sendResult ?? { sid: "SMxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx" };
    },
    async sendWhatsApp(opts) {
      calls.sendWhatsApp.push(opts);
      if (shouldFailSend) throw new Error("Twilio send failed");
      return sendResult ?? { sid: "SMxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx" };
    },
    validateSignature() {
      return !shouldRejectSignature;
    },
    VoiceResponse: twiml.VoiceResponse,
    MessagingResponse: twiml.MessagingResponse,
  };
}

module.exports = { createTwilioStub };
