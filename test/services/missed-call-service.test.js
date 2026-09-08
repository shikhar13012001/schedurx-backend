const { test, describe, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");

const { handleDeviceMissedCall } = require("../../src/services/missed-call-service");
const { createTableStub } = require("../helpers/supabase-table-stub");
const { createTwilioStub } = require("../helpers/twilio-stub");
const { config } = require("../../src/config");

function missedCallClinic(overrides = {}) {
  return {
    id: "clinic-1",
    name: "Nirmaya Clinic",
    phone: "+919999999999",
    settings: {
      communication: {
        channelsEnabled: ["sms"],
        workflows: [
          {
            id: "missed-call-sms",
            trigger: "missed_call_followup",
            channel: "sms",
            offsetMinutes: 0,
            enabled: true,
            template: "Sorry we missed you at {{clinicName}}!",
          },
        ],
      },
    },
    ...overrides,
  };
}

describe("handleDeviceMissedCall", () => {
  let priorFollowupFlag;
  beforeEach(() => {
    priorFollowupFlag = config.DEVICE_MISSED_CALL_SEND_FOLLOWUP;
  });
  afterEach(() => {
    config.DEVICE_MISSED_CALL_SEND_FOLLOWUP = priorFollowupFlag;
  });

  test("rejects a phone that doesn't normalize to a valid Indian mobile number", async () => {
    const supabaseClient = createTableStub();
    await assert.rejects(
      () => handleDeviceMissedCall(supabaseClient, null, { clinicId: "clinic-1", phone: "123", deviceCallTimestamp: 1 }, null),
      (err) => {
        assert.equal(err.code, "INVALID_PHONE");
        assert.equal(err.statusCode, 422);
        return true;
      },
    );
  });

  test("auto-creates a Patient and writes a CallLog row with outcome missed_logged when the follow-up flag is off", async () => {
    config.DEVICE_MISSED_CALL_SEND_FOLLOWUP = false;
    const supabaseClient = createTableStub({ Clinic: [missedCallClinic()] });
    const twilioClient = createTwilioStub();

    const result = await handleDeviceMissedCall(
      supabaseClient,
      twilioClient,
      { clinicId: "clinic-1", staffId: "staff_1", phone: "9888888888", deviceCallTimestamp: 1000 },
      null,
    );

    assert.equal(result.duplicate, false);
    assert.equal(result.followUpSent, false);
    assert.equal(result.callLog.outcome, "missed_logged");
    assert.equal(result.callLog.source, "android_native");
    assert.equal(result.patient.contactNumber, "+919888888888");
    assert.equal(twilioClient.calls.sendSms.length, 0, "no WhatsApp/SMS send while the flag is off");
  });

  test("sends the follow-up and flips the outcome to recovered_missed when the flag is on", async () => {
    config.DEVICE_MISSED_CALL_SEND_FOLLOWUP = true;
    const supabaseClient = createTableStub({ Clinic: [missedCallClinic()] });
    const twilioClient = createTwilioStub();

    const result = await handleDeviceMissedCall(
      supabaseClient,
      twilioClient,
      { clinicId: "clinic-1", staffId: "staff_1", phone: "9888888888", deviceCallTimestamp: 1000 },
      null,
    );

    assert.equal(result.followUpSent, true);
    assert.equal(twilioClient.calls.sendSms.length, 1);
    const updated = supabaseClient._tables.CallLog.find((row) => row.id === result.callLog.id);
    assert.equal(updated.outcome, "recovered_missed");
  });

  test("attributes the follow-up to the reporting staff member's own doctor, when linked", async () => {
    config.DEVICE_MISSED_CALL_SEND_FOLLOWUP = true;
    const supabaseClient = createTableStub({
      Clinic: [missedCallClinic()],
      Staff: [{ id: "staff_1", clinicId: "clinic-1", role: "doctor", doctorId: "doc_1" }],
      Doctor: [{ id: "doc_1", fullName: "Dr. Priya" }],
    });
    const twilioClient = createTwilioStub();

    await handleDeviceMissedCall(
      supabaseClient,
      twilioClient,
      { clinicId: "clinic-1", staffId: "staff_1", phone: "9888888888", deviceCallTimestamp: 1000 },
      null,
    );

    assert.match(twilioClient.calls.sendSms[0].body, /Sorry we missed you at Dr\. Priya!/);
  });

  test("falls back to clinic-level attribution when the reporting staff member has no linked doctor", async () => {
    config.DEVICE_MISSED_CALL_SEND_FOLLOWUP = true;
    const supabaseClient = createTableStub({
      Clinic: [missedCallClinic()],
      Staff: [{ id: "staff_1", clinicId: "clinic-1", role: "receptionist", doctorId: null }],
    });
    const twilioClient = createTwilioStub();

    await handleDeviceMissedCall(
      supabaseClient,
      twilioClient,
      { clinicId: "clinic-1", staffId: "staff_1", phone: "9888888888", deviceCallTimestamp: 1000 },
      null,
    );

    assert.match(twilioClient.calls.sendSms[0].body, /Sorry we missed you at Nirmaya Clinic!/);
  });

  test("marks the outcome as rate-limited (not recovered_missed) when the cooldown blocks the send", async () => {
    config.DEVICE_MISSED_CALL_SEND_FOLLOWUP = true;
    const supabaseClient = createTableStub({
      Clinic: [missedCallClinic()],
      CallLog: [
        {
          id: "call_prior",
          clinicId: "clinic-1",
          phone: "+919888888888",
          outcome: "recovered_missed",
          createdAt: new Date().toISOString(),
        },
      ],
    });
    const twilioClient = createTwilioStub();

    const result = await handleDeviceMissedCall(
      supabaseClient,
      twilioClient,
      { clinicId: "clinic-1", staffId: "staff_1", phone: "9888888888", deviceCallTimestamp: 2000 },
      null,
    );

    assert.equal(result.followUpSent, false);
    assert.equal(twilioClient.calls.sendSms.length, 0);
    const updated = supabaseClient._tables.CallLog.find((row) => row.id === result.callLog.id);
    assert.equal(updated.outcome, "missed_logged");
    assert.match(updated.summary, /already messaged this number/);
  });

  // createTableStub doesn't simulate real Postgres unique-constraint
  // violations (it has no notion of a UNIQUE index at all), so the
  // duplicate-report path — which relies on the DB itself rejecting a
  // second insert for the same (clinicId, phone, deviceCallTimestamp) — is
  // exercised here with a purpose-built minimal double that returns exactly
  // that error shape on its second call, rather than the shared stub.
  test("a duplicate report of the same device call (retry/double-fire) is a no-op, not an error", async () => {
    config.DEVICE_MISSED_CALL_SEND_FOLLOWUP = false;
    let insertCount = 0;
    const supabaseClient = {
      from(table) {
        if (table === "Patient") {
          return {
            select: () => ({ ilike: () => ({ eq: () => ({ order: () => ({ limit: () => ({ maybeSingle: async () => ({ data: null, error: null }) }) }) }) }) }),
            insert: (row) => ({ select: () => ({ single: async () => ({ data: { id: "pat_1", ...row }, error: null }) }) }),
          };
        }
        if (table === "CallLog") {
          return {
            insert: () => ({
              select: () => ({
                single: async () => {
                  insertCount += 1;
                  if (insertCount > 1) {
                    return { data: null, error: { message: 'duplicate key value violates unique constraint "call_log_device_dedup_idx"' } };
                  }
                  return { data: { id: "call_1", outcome: "missed_logged" }, error: null };
                },
              }),
            }),
          };
        }
        throw new Error(`unexpected table in this minimal double: ${table}`);
      },
    };

    const first = await handleDeviceMissedCall(
      supabaseClient,
      null,
      { clinicId: "clinic-1", staffId: "staff_1", phone: "9888888888", deviceCallTimestamp: 5000 },
      null,
    );
    assert.equal(first.duplicate, false);

    const second = await handleDeviceMissedCall(
      supabaseClient,
      null,
      { clinicId: "clinic-1", staffId: "staff_1", phone: "9888888888", deviceCallTimestamp: 5000 },
      null,
    );
    assert.equal(second.duplicate, true);
  });
});
