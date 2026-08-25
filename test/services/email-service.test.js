const { test, describe } = require("node:test");
const assert = require("node:assert/strict");

const { createEmailClient } = require("../../src/services/email-service");

describe("createEmailClient", () => {
  test("returns null when the API key or recipient aren't configured", () => {
    assert.equal(createEmailClient({}), null);
    assert.equal(createEmailClient({ apiKey: "re_test" }), null);
    assert.equal(createEmailClient({ alertTo: "ops@example.com" }), null);
  });

  test("returns a client with sendAlert when both are set", () => {
    const client = createEmailClient({ apiKey: "re_test", alertTo: "ops@example.com" });
    assert.ok(client);
    assert.equal(typeof client.sendAlert, "function");
  });

  test("sendAlert POSTs to Resend with the expected shape, defaulting to the shared sender", async (t) => {
    const calls = [];
    t.mock.method(global, "fetch", async (url, opts) => {
      calls.push({ url, opts });
      return { ok: true, json: async () => ({ id: "email_123" }) };
    });

    const client = createEmailClient({ apiKey: "re_test", alertTo: "ops@example.com" });
    const result = await client.sendAlert({ subject: "Something broke", text: "details here" });

    assert.equal(result.id, "email_123");
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, "https://api.resend.com/emails");
    assert.equal(calls[0].opts.headers.Authorization, "Bearer re_test");
    const body = JSON.parse(calls[0].opts.body);
    assert.equal(body.from, "onboarding@resend.dev");
    assert.equal(body.to, "ops@example.com");
    assert.equal(body.subject, "[ScheduRx alert] Something broke");
    assert.equal(body.text, "details here");
  });

  test("sendAlert uses a custom from address when configured", async (t) => {
    const calls = [];
    t.mock.method(global, "fetch", async (url, opts) => {
      calls.push({ url, opts });
      return { ok: true, json: async () => ({ id: "email_456" }) };
    });

    const client = createEmailClient({ apiKey: "re_test", from: "alerts@myclinic.com", alertTo: "ops@example.com" });
    await client.sendAlert({ subject: "x", text: "y" });

    assert.equal(JSON.parse(calls[0].opts.body).from, "alerts@myclinic.com");
  });

  test("sendAlert throws with the response body on a non-OK Resend response", async (t) => {
    t.mock.method(global, "fetch", async () => ({ ok: false, status: 422, text: async () => "invalid 'to' field" }));

    const client = createEmailClient({ apiKey: "re_test", alertTo: "ops@example.com" });
    await assert.rejects(() => client.sendAlert({ subject: "x", text: "y" }), /invalid 'to' field/);
  });
});
