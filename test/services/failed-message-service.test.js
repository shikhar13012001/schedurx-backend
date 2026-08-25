const { test, describe } = require("node:test");
const assert = require("node:assert/strict");

const failedMessageSvc = require("../../src/services/failed-message-service");
const { createTableStub } = require("../helpers/supabase-table-stub");

describe("isRetryableError", () => {
  test("terminal Twilio error codes are not retryable", () => {
    assert.equal(failedMessageSvc.isRetryableError(Object.assign(new Error("x"), { code: "63016" })), false);
    assert.equal(failedMessageSvc.isRetryableError(Object.assign(new Error("x"), { code: "21211" })), false);
  });

  test("an error with no Twilio code (network/generic failure) is retryable", () => {
    assert.equal(failedMessageSvc.isRetryableError(new Error("network blip")), true);
  });

  test("a rate-limit style code not on the terminal list is retryable", () => {
    assert.equal(failedMessageSvc.isRetryableError(Object.assign(new Error("x"), { code: "20429" })), true);
  });
});

describe("enqueue", () => {
  test("writes a pending row with the resend payload and a near-term nextAttemptAt", async () => {
    const supabaseClient = createTableStub({ FailedMessage: [] });
    await failedMessageSvc.enqueue(
      supabaseClient,
      {
        clinicId: "clinic-1",
        channel: "whatsapp",
        toPhone: "+919888888888",
        fromPhone: "+14155238886",
        contentSid: "HXtest",
        contentVariables: { 1: "Rahul" },
        purpose: "booking_confirmed",
        error: new Error("temporary blip"),
      },
      null,
    );

    assert.equal(supabaseClient._tables.FailedMessage.length, 1);
    const row = supabaseClient._tables.FailedMessage[0];
    assert.equal(row.status, "pending");
    assert.equal(row.attempts, 0);
    assert.equal(row.contentSid, "HXtest");
    assert.ok(new Date(row.nextAttemptAt).getTime() > Date.now());
  });

  test("skips terminal errors entirely — never even writes a row", async () => {
    const supabaseClient = createTableStub({ FailedMessage: [] });
    await failedMessageSvc.enqueue(
      supabaseClient,
      { clinicId: "clinic-1", channel: "whatsapp", toPhone: "+919888888888", purpose: "booking_confirmed", error: Object.assign(new Error("x"), { code: "63016" }) },
      null,
    );
    assert.equal(supabaseClient._tables.FailedMessage.length, 0);
  });
});

function dueRow(overrides = {}) {
  return {
    id: "fmsg_1",
    clinicId: "clinic-1",
    channel: "sms",
    toPhone: "+919888888888",
    fromPhone: null,
    body: "hello",
    contentSid: null,
    contentVariables: null,
    purpose: "booking_confirmed",
    attempts: 0,
    maxAttempts: 3,
    status: "pending",
    nextAttemptAt: new Date(Date.now() - 1000).toISOString(),
    ...overrides,
  };
}

describe("processDue", () => {
  test("a successful resend marks the row resolved", async () => {
    const supabaseClient = createTableStub({ FailedMessage: [dueRow()] });
    // sendSms is extracted as a bare reference in processDue (matching how
    // the real twilio-client.js's methods work — closure-based, no `this`),
    // so this stub must not depend on `this` either.
    const sendSmsCalls = [];
    const twilioClient = {
      async sendSms(opts) {
        sendSmsCalls.push(opts);
        return { sid: "SMnew" };
      },
    };

    const result = await failedMessageSvc.processDue(supabaseClient, twilioClient, null);

    assert.equal(result.attempted, 1);
    assert.equal(supabaseClient._tables.FailedMessage[0].status, "resolved");
    assert.equal(sendSmsCalls.length, 1);
    assert.equal(sendSmsCalls[0].to, "+919888888888");
  });

  test("a failed resend under maxAttempts stays pending with a later nextAttemptAt", async () => {
    const supabaseClient = createTableStub({ FailedMessage: [dueRow({ attempts: 0, maxAttempts: 3 })] });
    const twilioClient = {
      async sendSms() {
        throw new Error("still failing");
      },
    };

    await failedMessageSvc.processDue(supabaseClient, twilioClient, null);

    const row = supabaseClient._tables.FailedMessage[0];
    assert.equal(row.status, "pending");
    assert.equal(row.attempts, 1);
    assert.ok(new Date(row.nextAttemptAt).getTime() > Date.now());
  });

  test("a failed resend at maxAttempts is marked exhausted, not retried again", async () => {
    const supabaseClient = createTableStub({ FailedMessage: [dueRow({ attempts: 2, maxAttempts: 3 })] });
    const twilioClient = {
      async sendSms() {
        throw new Error("still failing");
      },
    };

    await failedMessageSvc.processDue(supabaseClient, twilioClient, null);

    const row = supabaseClient._tables.FailedMessage[0];
    assert.equal(row.status, "exhausted");
    assert.equal(row.attempts, 3);
  });

  test("exhaustion sends an alert email when an emailClient is provided", async () => {
    const supabaseClient = createTableStub({ FailedMessage: [dueRow({ attempts: 2, maxAttempts: 3, purpose: "booking_confirmed" })] });
    const twilioClient = {
      async sendSms() {
        throw new Error("still failing");
      },
    };
    const alerts = [];
    const emailClient = { async sendAlert(opts) { alerts.push(opts); } };

    await failedMessageSvc.processDue(supabaseClient, twilioClient, null, emailClient);

    assert.equal(alerts.length, 1);
    assert.match(alerts[0].subject, /booking_confirmed/);
    assert.match(alerts[0].text, /\+919888888888/);
  });

  test("does not email when the retry still has attempts left (not yet exhausted)", async () => {
    const supabaseClient = createTableStub({ FailedMessage: [dueRow({ attempts: 0, maxAttempts: 3 })] });
    const twilioClient = {
      async sendSms() {
        throw new Error("still failing");
      },
    };
    const alerts = [];
    const emailClient = { async sendAlert(opts) { alerts.push(opts); } };

    await failedMessageSvc.processDue(supabaseClient, twilioClient, null, emailClient);

    assert.equal(alerts.length, 0);
  });

  test("a failed emailClient.sendAlert never breaks retry processing itself", async () => {
    const supabaseClient = createTableStub({ FailedMessage: [dueRow({ attempts: 2, maxAttempts: 3 })] });
    const twilioClient = {
      async sendSms() {
        throw new Error("still failing");
      },
    };
    const emailClient = {
      async sendAlert() {
        throw new Error("SMTP down too");
      },
    };

    await assert.doesNotReject(() => failedMessageSvc.processDue(supabaseClient, twilioClient, null, emailClient));
    assert.equal(supabaseClient._tables.FailedMessage[0].status, "exhausted");
  });

  test("a resend that now fails with a terminal error is exhausted immediately, regardless of attempts left", async () => {
    const supabaseClient = createTableStub({ FailedMessage: [dueRow({ attempts: 0, maxAttempts: 3 })] });
    const twilioClient = {
      async sendSms() {
        throw Object.assign(new Error("unsubscribed"), { code: "21610" });
      },
    };

    await failedMessageSvc.processDue(supabaseClient, twilioClient, null);

    assert.equal(supabaseClient._tables.FailedMessage[0].status, "exhausted");
  });

  test("does nothing when there's no twilioClient, or no due rows", async () => {
    const supabaseClient = createTableStub({ FailedMessage: [dueRow({ nextAttemptAt: new Date(Date.now() + 60_000).toISOString() })] });
    const twilioClient = { async sendSms() { throw new Error("should not be called"); } };

    const result = await failedMessageSvc.processDue(supabaseClient, null, null);
    assert.equal(result.attempted, 0);

    const result2 = await failedMessageSvc.processDue(supabaseClient, twilioClient, null);
    assert.equal(result2.attempted, 0, "row's nextAttemptAt is in the future — not due yet");
  });
});
