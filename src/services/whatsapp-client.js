// TODO(whatsapp): replace this stub with a real POST to
//   https://graph.facebook.com/v20.0/{WHATSAPP_PHONE_NUMBER_ID}/messages
//   Authorization: Bearer {WHATSAPP_ACCESS_TOKEN}
// once those env vars exist. Until then this always "succeeds" so Thread/
// ChatMsg/WaLog persistence and the REST response shape in messaging-service.js
// are fully real and never need to change when this is wired up — swapping in
// the real integration later is a one-file change here, plus adding the two
// WHATSAPP_* vars to config.js at that time.

const crypto = require("node:crypto");

async function sendWhatsAppMessage({ toPhone, body }, log) {
  log?.info(
    { toPhone, bodyPreview: body?.slice(0, 40) },
    "[whatsapp:stub] send skipped — WhatsApp integration not configured",
  );
  return { ok: true, stubbed: true, waMessageId: `stub_${crypto.randomUUID()}` };
}

module.exports = { sendWhatsAppMessage };
