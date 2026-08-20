// Carrier conditional-call-forwarding dial-code templates — centralized so
// they can be corrected in one place if a carrier changes its supplementary
// service codes, per the onboarding spec's explicit requirement. These are
// GSM/MMI codes dialled on the CLINIC'S OWN phone to forward unanswered
// calls to ScheduRx's shared number; nothing here places a call itself.

const { config } = require("../config");

// The number every clinic forwards to. Falls back through the shared
// messaging senders since (as of this deployment) it's the same physical
// Twilio number that also answers /webhooks/twilio/voice.
function forwardingNumber() {
  return config.TWILIO_FORWARDING_NUMBER ?? config.TWILIO_WHATSAPP_FROM ?? config.TWILIO_SMS_FROM ?? null;
}

const CARRIERS = {
  jio: {
    id: "jio",
    name: "Jio",
    // "No Answer" is the only one actually offered to the user — the rest
    // exist so a future settings screen can offer unconditional/busy/
    // unreachable variants without another release.
    codes: {
      noAnswer: { activate: "*403*{number}", deactivate: "*404" },
      unconditional: { activate: "*401*{number}", deactivate: "*402" },
      busy: { activate: "*405*{number}", deactivate: "*406" },
      unreachable: { activate: "*409*{number}", deactivate: "*410" },
      disableAll: { activate: "*413", deactivate: null },
    },
    manualPath: "MyJio → Profile → Mobile Settings → Service Settings → Call Forwarding",
  },
  airtel: {
    id: "airtel",
    name: "Airtel",
    codes: {
      noAnswer: { activate: "*61*{number}#", deactivate: "##61#" },
      unconditional: { activate: "*21*{number}#", deactivate: "##21#" },
      busy: { activate: "*67*{number}#", deactivate: "##67#" },
      unreachable: { activate: "*62*{number}#", deactivate: "##62#" },
    },
    manualPath: "Airtel Thanks app → Call Settings → Call Forwarding",
  },
};

// Every clinic gets steered to "forward when unanswered" — the plan is
// explicit that unconditional forwarding is never the default.
const PREFERRED_CONDITION = "noAnswer";

function carrier(carrierId) {
  return CARRIERS[carrierId] ?? null;
}

// Builds the literal dial string (e.g. "*61*+919876543210#") and its tel:
// URI (special characters encoded) for the given carrier's preferred
// no-answer forwarding code. Returns null for "other"/unknown carriers —
// callers fall back to manual instructions only.
function buildDialCode(carrierId) {
  const c = carrier(carrierId);
  const number = forwardingNumber();
  if (!c || !number) return null;
  const template = c.codes[PREFERRED_CONDITION]?.activate;
  if (!template) return null;
  const dialString = template.replace("{number}", number);
  return { dialString, telUri: `tel:${encodeURIComponent(dialString)}` };
}

module.exports = { CARRIERS, PREFERRED_CONDITION, forwardingNumber, carrier, buildDialCode };
