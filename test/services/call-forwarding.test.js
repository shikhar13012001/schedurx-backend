const { test, describe, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");

const { config } = require("../../src/config");
const { buildDialCode } = require("../../src/lib/call-forwarding");

// lib/call-forwarding.js reads the already-parsed `config` object directly
// (not process.env) at call time, so tests mutate that object's fields —
// simpler and more reliable than fighting dotenv's re-population of
// process.env on a fresh require of config.js.
let saved;
beforeEach(() => {
  saved = { forwarding: config.TWILIO_FORWARDING_NUMBER, whatsapp: config.TWILIO_WHATSAPP_FROM, sms: config.TWILIO_SMS_FROM };
});
afterEach(() => {
  config.TWILIO_FORWARDING_NUMBER = saved.forwarding;
  config.TWILIO_WHATSAPP_FROM = saved.whatsapp;
  config.TWILIO_SMS_FROM = saved.sms;
});

describe("buildDialCode", () => {
  test("Jio no-answer code substitutes the forwarding number", () => {
    config.TWILIO_FORWARDING_NUMBER = "+19995551234";
    const result = buildDialCode("jio");
    assert.equal(result.dialString, "*403*+19995551234");
    assert.equal(result.telUri, "tel:*403*%2B19995551234");
  });

  test("Airtel no-answer code substitutes the forwarding number", () => {
    config.TWILIO_FORWARDING_NUMBER = "+19995551234";
    const result = buildDialCode("airtel");
    assert.equal(result.dialString, "*61*+19995551234#");
  });

  test("falls back to TWILIO_WHATSAPP_FROM when TWILIO_FORWARDING_NUMBER isn't set", () => {
    config.TWILIO_FORWARDING_NUMBER = undefined;
    config.TWILIO_WHATSAPP_FROM = "+19998887777";
    const result = buildDialCode("jio");
    assert.equal(result.dialString, "*403*+19998887777");
  });

  test("returns null for a carrier with no dial-code template ('other')", () => {
    config.TWILIO_FORWARDING_NUMBER = "+19995551234";
    assert.equal(buildDialCode("other"), null);
    assert.equal(buildDialCode("unknown-carrier"), null);
  });

  test("returns null when no forwarding number is configured anywhere", () => {
    config.TWILIO_FORWARDING_NUMBER = undefined;
    config.TWILIO_WHATSAPP_FROM = undefined;
    config.TWILIO_SMS_FROM = undefined;
    assert.equal(buildDialCode("jio"), null);
  });
});
