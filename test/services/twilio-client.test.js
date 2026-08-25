const { test, describe } = require("node:test");
const assert = require("node:assert/strict");

const { createTwilioClient } = require("../../src/services/twilio-client");

// Real production usage never passes sdkClient — see twilio-client.js's own
// comment on why this injection point exists at all: without it, the
// toPhone-vs-to field mismatch and the wrong /status-callback route (both
// shipped and were only caught by a live send) would still have zero test
// coverage today.
function fakeSdkClient({ createResult } = {}) {
  const calls = [];
  return {
    calls,
    messages: {
      async create(payload) {
        calls.push(payload);
        return createResult ?? { sid: "SMfake123", status: "queued" };
      },
    },
  };
}

describe("sendSms", () => {
  test("sends the expected payload and reports toPhone (not the raw 'to' the caller passed) to onMessageSent", async () => {
    const sdkClient = fakeSdkClient();
    const logged = [];
    const twilioClient = createTwilioClient({
      accountSid: "ACtest",
      authToken: "tok",
      smsFrom: "+15550000000",
      sdkClient,
      onMessageSent: (info) => logged.push(info),
    });

    const result = await twilioClient.sendSms({ to: "+919888888888", body: "hi", clinicId: "clinic-1", purpose: "booking_confirmed" });

    assert.equal(result.sid, "SMfake123");
    assert.deepEqual(sdkClient.calls[0], { to: "+919888888888", from: "+15550000000", body: "hi" });

    // The exact bug found live: logSent building { to } instead of
    // { toPhone } silently recorded every MessageLog row's recipient as
    // null, since message-log-service.js's recordSent destructures
    // `toPhone`, not `to`.
    await new Promise((r) => setImmediate(r)); // onMessageSent is fire-and-forget
    assert.equal(logged.length, 1);
    assert.equal(logged[0].toPhone, "+919888888888");
    assert.equal(logged[0].channel, "sms");
    assert.equal(logged[0].clinicId, "clinic-1");
    assert.equal(logged[0].purpose, "booking_confirmed");
    assert.equal(logged[0].initialStatus, "queued");
  });

  test("uses the explicit 'from' over smsFrom when both are given", async () => {
    const sdkClient = fakeSdkClient();
    const twilioClient = createTwilioClient({ accountSid: "ACtest", authToken: "tok", smsFrom: "+15550000000", sdkClient });

    await twilioClient.sendSms({ to: "+919888888888", from: "+15559999999", body: "hi" });

    assert.equal(sdkClient.calls[0].from, "+15559999999");
  });

  test("contentSid path stringifies contentVariables and omits body", async () => {
    const sdkClient = fakeSdkClient();
    const twilioClient = createTwilioClient({ accountSid: "ACtest", authToken: "tok", smsFrom: "+15550000000", sdkClient });

    await twilioClient.sendSms({ to: "+919888888888", contentSid: "HXtest", contentVariables: { 1: "Rahul" }, body: "ignored" });

    assert.equal(sdkClient.calls[0].contentSid, "HXtest");
    assert.equal(sdkClient.calls[0].contentVariables, JSON.stringify({ 1: "Rahul" }));
    assert.equal(sdkClient.calls[0].body, undefined);
  });

  test("attaches statusCallback pointing at the real /webhooks/twilio/message-status route when configured", async () => {
    const sdkClient = fakeSdkClient();
    const twilioClient = createTwilioClient({
      accountSid: "ACtest",
      authToken: "tok",
      smsFrom: "+15550000000",
      statusCallbackBaseUrl: "https://api.schedurx.com",
      sdkClient,
    });

    await twilioClient.sendSms({ to: "+919888888888", body: "hi" });

    // The exact bug found live: this pointed at /status-callback, a route
    // that was never actually mounted — every callback from Twilio hit a
    // real 404 and no MessageLog row ever progressed past 'queued'.
    assert.equal(sdkClient.calls[0].statusCallback, "https://api.schedurx.com/webhooks/twilio/message-status");
  });

  test("omits statusCallback entirely when statusCallbackBaseUrl isn't configured", async () => {
    const sdkClient = fakeSdkClient();
    const twilioClient = createTwilioClient({ accountSid: "ACtest", authToken: "tok", smsFrom: "+15550000000", sdkClient });

    await twilioClient.sendSms({ to: "+919888888888", body: "hi" });

    assert.equal("statusCallback" in sdkClient.calls[0], false);
  });

  test("works with no onMessageSent configured at all — no crash, nothing to call", async () => {
    const sdkClient = fakeSdkClient();
    const twilioClient = createTwilioClient({ accountSid: "ACtest", authToken: "tok", smsFrom: "+15550000000", sdkClient });

    await assert.doesNotReject(() => twilioClient.sendSms({ to: "+919888888888", body: "hi" }));
  });

  test("a throwing onMessageSent never makes the send itself look like it failed", async () => {
    const sdkClient = fakeSdkClient();
    const twilioClient = createTwilioClient({
      accountSid: "ACtest",
      authToken: "tok",
      smsFrom: "+15550000000",
      sdkClient,
      onMessageSent: () => {
        throw new Error("MessageLog insert failed");
      },
    });

    const result = await twilioClient.sendSms({ to: "+919888888888", body: "hi" });
    assert.equal(result.sid, "SMfake123");
  });
});

describe("sendWhatsApp", () => {
  test("prefixes to/from with whatsapp: for the SDK call, but reports the plain E.164 number to onMessageSent", async () => {
    const sdkClient = fakeSdkClient();
    const logged = [];
    const twilioClient = createTwilioClient({
      accountSid: "ACtest",
      authToken: "tok",
      whatsappFrom: "+14155238886",
      sdkClient,
      onMessageSent: (info) => logged.push(info),
    });

    await twilioClient.sendWhatsApp({ to: "+919888888888", body: "hi" });

    assert.equal(sdkClient.calls[0].to, "whatsapp:+919888888888");
    assert.equal(sdkClient.calls[0].from, "whatsapp:+14155238886");

    await new Promise((r) => setImmediate(r));
    assert.equal(logged[0].toPhone, "+919888888888", "onMessageSent must get the plain number, not the whatsapp:-prefixed wire form");
    assert.equal(logged[0].channel, "whatsapp");
  });

  test("attaches the same real statusCallback route as sendSms", async () => {
    const sdkClient = fakeSdkClient();
    const twilioClient = createTwilioClient({
      accountSid: "ACtest",
      authToken: "tok",
      whatsappFrom: "+14155238886",
      statusCallbackBaseUrl: "https://api.schedurx.com",
      sdkClient,
    });

    await twilioClient.sendWhatsApp({ to: "+919888888888", body: "hi" });

    assert.equal(sdkClient.calls[0].statusCallback, "https://api.schedurx.com/webhooks/twilio/message-status");
  });
});
