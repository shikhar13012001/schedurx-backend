const { test, describe } = require("node:test");
const assert = require("node:assert/strict");

const {
  buildDelayedReminderEntries,
  sendImmediateWorkflowMessages,
  sendDelayedWorkflowMessage,
} = require("../../src/services/comms-workflow-service");
const { createTableStub } = require("../helpers/supabase-table-stub");
const { createTwilioStub } = require("../helpers/twilio-stub");

function makeClinic(overrides = {}) {
  return {
    id: "clinic-1",
    name: "Nirmaya Clinic",
    phone: "+919999999999",
    whatsappFrom: "+14155238886",
    settings: {
      communication: {
        channelsEnabled: ["sms", "whatsapp"],
        workflows: [],
      },
    },
    ...overrides,
  };
}

describe("buildDelayedReminderEntries", () => {
  const HOUR_MS = 60 * 60_000;

  test("builds one composite-identifier entry per enabled, channel-allowed delayed workflow", () => {
    const clinic = makeClinic({
      settings: {
        communication: {
          channelsEnabled: ["whatsapp"],
          workflows: [
            {
              id: "reminder-1h",
              trigger: "reminder",
              channel: "whatsapp",
              offsetMinutes: -60,
              enabled: true,
              template: "...",
            },
            {
              id: "review-2h-after",
              trigger: "review_request",
              channel: "whatsapp",
              offsetMinutes: 150,
              enabled: true,
              template: "...",
            },
          ],
        },
      },
    });
    // Plenty of lead time (2h), so the "reminder" trigger gets its full 1h-before tier.
    const entries = buildDelayedReminderEntries(clinic, "apt_1", Date.now() + 2 * HOUR_MS);
    assert.deepEqual(entries, [
      { delta: -60, identifier: "apt_1::reminder-1h" },
      { delta: 150, identifier: "apt_1::review-2h-after" },
    ]);
  });

  test("skips disabled workflows and immediate-trigger workflows", () => {
    const clinic = makeClinic({
      settings: {
        communication: {
          channelsEnabled: ["sms"],
          workflows: [
            {
              id: "disabled-one",
              trigger: "reminder",
              channel: "sms",
              offsetMinutes: -60,
              enabled: false,
              template: "...",
            },
            {
              id: "booking-conf",
              trigger: "booking_confirmed",
              channel: "sms",
              offsetMinutes: 0,
              enabled: true,
              template: "...",
            },
          ],
        },
      },
    });
    assert.deepEqual(buildDelayedReminderEntries(clinic, "apt_1", Date.now() + 2 * HOUR_MS), []);
  });

  test("skips a workflow whose channel isn't enabled for the clinic", () => {
    const clinic = makeClinic({
      settings: {
        communication: {
          channelsEnabled: ["sms"], // whatsapp not enabled
          workflows: [
            {
              id: "reminder-1h",
              trigger: "reminder",
              channel: "whatsapp",
              offsetMinutes: -60,
              enabled: true,
              template: "...",
            },
          ],
        },
      },
    });
    assert.deepEqual(buildDelayedReminderEntries(clinic, "apt_1", Date.now() + 2 * HOUR_MS), []);
  });

  test("returns [] when settings.communication is absent entirely", () => {
    assert.deepEqual(buildDelayedReminderEntries({ id: "clinic-1" }, "apt_1", Date.now() + 2 * HOUR_MS), []);
  });

  describe("the 'reminder' trigger's lead-time fallback (1h -> 15m -> skip)", () => {
    function reminderClinic() {
      return makeClinic({
        settings: {
          communication: {
            channelsEnabled: ["whatsapp"],
            workflows: [
              {
                id: "reminder-1h",
                trigger: "reminder",
                channel: "whatsapp",
                offsetMinutes: -60,
                enabled: true,
                template: "...",
              },
            ],
          },
        },
      });
    }

    test("uses the 1h-before tier when there's at least an hour of lead time", () => {
      const entries = buildDelayedReminderEntries(reminderClinic(), "apt_1", Date.now() + 90 * 60_000);
      assert.deepEqual(entries, [{ delta: -60, identifier: "apt_1::reminder-1h" }]);
    });

    test("falls back to the 15m-before tier when there's under an hour but at least 15 minutes", () => {
      const entries = buildDelayedReminderEntries(reminderClinic(), "apt_1", Date.now() + 30 * 60_000);
      assert.deepEqual(entries, [{ delta: -15, identifier: "apt_1::reminder-1h" }]);
    });

    test("skips the reminder entirely when there's under 15 minutes of lead time", () => {
      const entries = buildDelayedReminderEntries(reminderClinic(), "apt_1", Date.now() + 10 * 60_000);
      assert.deepEqual(entries, []);
    });

    test("a non-reminder delayed trigger keeps its configured offset regardless of lead time", () => {
      const clinic = makeClinic({
        settings: {
          communication: {
            channelsEnabled: ["whatsapp"],
            workflows: [
              {
                id: "post-visit",
                trigger: "post_appointment",
                channel: "whatsapp",
                offsetMinutes: 60,
                enabled: true,
                template: "...",
              },
            ],
          },
        },
      });
      // Only 5 minutes of lead time — would skip a "reminder" trigger, but
      // post_appointment isn't lead-time-sensitive (it fires after start).
      const entries = buildDelayedReminderEntries(clinic, "apt_1", Date.now() + 5 * 60_000);
      assert.deepEqual(entries, [{ delta: 60, identifier: "apt_1::post-visit" }]);
    });
  });
});

describe("sendImmediateWorkflowMessages", () => {
  test("sends each enabled, channel-allowed workflow matching the trigger and records a Reminder row", async () => {
    const supabaseClient = createTableStub();
    const twilioClient = createTwilioStub();
    const clinic = makeClinic({
      settings: {
        communication: {
          channelsEnabled: ["sms"],
          workflows: [
            {
              id: "booking-conf",
              trigger: "booking_confirmed",
              channel: "sms",
              offsetMinutes: 0,
              enabled: true,
              template: "Hi {{patientName}}, booked with {{doctorName}}.",
            },
          ],
        },
      },
    });

    await sendImmediateWorkflowMessages(
      {
        supabaseClient,
        twilioClient,
        clinic,
        trigger: "booking_confirmed",
        appointmentId: "apt_1",
        toPhone: "+919888888888",
        data: { patientName: "Rahul", doctorName: "Dr. Priya" },
      },
      null,
    );

    assert.equal(twilioClient.calls.sendSms.length, 1);
    assert.equal(twilioClient.calls.sendSms[0].to, "+919888888888");
    assert.match(twilioClient.calls.sendSms[0].body, /Hi Rahul, booked with Dr\. Priya\./);

    assert.equal(supabaseClient._tables.Reminder.length, 1);
    assert.equal(supabaseClient._tables.Reminder[0].appointmentId, "apt_1");
    assert.equal(supabaseClient._tables.Reminder[0].type, "booking-conf");
    assert.equal(supabaseClient._tables.Reminder[0].status, "sent");
  });

  test("does nothing without a twilioClient or a toPhone", async () => {
    const supabaseClient = createTableStub();
    const twilioClient = createTwilioStub();
    const clinic = makeClinic({
      settings: {
        communication: {
          channelsEnabled: ["sms"],
          workflows: [{ id: "x", trigger: "booking_confirmed", channel: "sms", enabled: true, template: "hi" }],
        },
      },
    });

    await sendImmediateWorkflowMessages(
      {
        supabaseClient,
        twilioClient: null,
        clinic,
        trigger: "booking_confirmed",
        appointmentId: "apt_1",
        toPhone: "+919888888888",
        data: {},
      },
      null,
    );
    await sendImmediateWorkflowMessages(
      {
        supabaseClient,
        twilioClient,
        clinic,
        trigger: "booking_confirmed",
        appointmentId: "apt_1",
        toPhone: null,
        data: {},
      },
      null,
    );

    assert.equal(twilioClient.calls.sendSms.length, 0);
  });

  // Phase 7: {{reviewUrl}}/{{textCommsUrl}} are now real data keys any
  // workflow template can reference — reviewUrl from Clinic.googleReviewUrl,
  // textCommsUrl a wa.me deep link into this booking's own Thread.
  test("includes reviewUrl/textCommsUrl so a workflow template can reference them", async () => {
    const supabaseClient = createTableStub();
    const twilioClient = createTwilioStub();
    const clinic = makeClinic({
      googleReviewUrl: "https://g.page/r/nirmaya-clinic/review",
      whatsappFrom: "+14155238886",
      settings: {
        communication: {
          channelsEnabled: ["sms"],
          workflows: [
            { id: "review-req", trigger: "booking_confirmed", channel: "sms", enabled: true, template: "Leave a review: {{reviewUrl}} or chat: {{textCommsUrl}}" },
          ],
        },
      },
    });

    await sendImmediateWorkflowMessages(
      { supabaseClient, twilioClient, clinic, trigger: "booking_confirmed", appointmentId: "apt_1", toPhone: "+919888888888", data: {} },
      null,
    );

    assert.match(twilioClient.calls.sendSms[0].body, /Leave a review: https:\/\/g\.page\/r\/nirmaya-clinic\/review/);
    assert.match(twilioClient.calls.sendSms[0].body, /chat: https:\/\/wa\.me\/14155238886\?text=BOOKING%20apt_1/);
  });

  test("records a failed status without throwing when the send errors, and queues a retry", async () => {
    const supabaseClient = createTableStub();
    const twilioClient = createTwilioStub({ shouldFailSend: true });
    const clinic = makeClinic({
      settings: {
        communication: {
          channelsEnabled: ["sms"],
          workflows: [{ id: "x", trigger: "cancellation", channel: "sms", enabled: true, template: "sorry" }],
        },
      },
    });

    await sendImmediateWorkflowMessages(
      {
        supabaseClient,
        twilioClient,
        clinic,
        trigger: "cancellation",
        appointmentId: "apt_1",
        toPhone: "+919888888888",
        data: {},
      },
      { error: () => {} },
    );

    assert.equal(supabaseClient._tables.Reminder[0].status, "failed");

    // The stub's generic "Twilio SMS send failed" error carries no Twilio
    // error code, so it's treated as transient (see failed-message-service.js's
    // isRetryableError) and worth queuing a retry for.
    assert.equal(supabaseClient._tables.FailedMessage.length, 1);
    const queued = supabaseClient._tables.FailedMessage[0];
    assert.equal(queued.toPhone, "+919888888888");
    assert.equal(queued.channel, "sms");
    assert.equal(queued.purpose, "cancellation");
    assert.equal(queued.status, "pending");
  });

  test("does not queue a retry for a terminal error (e.g. outside the WhatsApp session window)", async () => {
    const supabaseClient = createTableStub({ FailedMessage: [] });
    const terminalErr = Object.assign(new Error("outside allowed window"), { code: "63016" });
    const twilioClient = {
      calls: { sendSms: [], sendWhatsApp: [] },
      async sendWhatsApp() {
        throw terminalErr;
      },
    };
    const clinic = makeClinic({
      settings: {
        communication: {
          channelsEnabled: ["whatsapp"],
          workflows: [{ id: "x", trigger: "booking_confirmed", channel: "whatsapp", enabled: true, contentSid: "HXtest", contentVariables: ["patientName"] }],
        },
      },
    });

    await sendImmediateWorkflowMessages(
      {
        supabaseClient,
        twilioClient,
        clinic,
        trigger: "booking_confirmed",
        appointmentId: "apt_1",
        toPhone: "+919888888888",
        data: { patientName: "Rahul" },
      },
      null,
    );

    assert.equal(supabaseClient._tables.Reminder[0].status, "failed");
    assert.equal(supabaseClient._tables.FailedMessage.length, 0, "a 63016 failure will fail again for the same reason — must not queue a pointless retry");
  });
});

describe("sendDelayedWorkflowMessage", () => {
  test("looks up patient/doctor/clinic fresh, sends, and records the Reminder row", async () => {
    const supabaseClient = createTableStub({
      Clinic: [
        makeClinic({
          settings: {
            communication: {
              channelsEnabled: ["whatsapp"],
              workflows: [
                {
                  id: "reminder-24h",
                  trigger: "reminder",
                  channel: "whatsapp",
                  offsetMinutes: -1440,
                  enabled: true,
                  template: "Reminder for {{patientName}} with {{doctorName}}",
                },
              ],
            },
          },
        }),
      ],
      Appointment: [
        { id: "apt_1", patientId: "pat_1", doctorId: "doc_1", timeslot: "2026-08-20T10:00:00", symptoms: "Fever" },
      ],
      Patient: [{ id: "pat_1", fullName: "Rahul", contactNumber: "+919888888888" }],
      Doctor: [{ id: "doc_1", fullName: "Dr. Priya" }],
    });
    const twilioClient = createTwilioStub();

    await sendDelayedWorkflowMessage(
      { supabaseClient, twilioClient, clinicId: "clinic-1", appointmentId: "apt_1", workflowId: "reminder-24h" },
      null,
    );

    assert.equal(twilioClient.calls.sendWhatsApp.length, 1);
    assert.equal(twilioClient.calls.sendWhatsApp[0].to, "+919888888888");
    assert.match(twilioClient.calls.sendWhatsApp[0].body, /Reminder for Rahul with Dr\. Priya/);
    assert.equal(supabaseClient._tables.Reminder[0].status, "sent");
  });

  test("a review_request workflow's template can reference {{reviewUrl}}", async () => {
    const supabaseClient = createTableStub({
      Clinic: [
        makeClinic({
          googleReviewUrl: "https://g.page/r/nirmaya-clinic/review",
          settings: {
            communication: {
              channelsEnabled: ["whatsapp"],
              workflows: [
                { id: "review-2h-after", trigger: "review_request", channel: "whatsapp", offsetMinutes: 150, enabled: true, template: "Thanks for visiting! Please review us: {{reviewUrl}}" },
              ],
            },
          },
        }),
      ],
      Appointment: [{ id: "apt_1", patientId: "pat_1", doctorId: "doc_1", timeslot: "2026-08-20T10:00:00" }],
      Patient: [{ id: "pat_1", fullName: "Rahul", contactNumber: "+919888888888" }],
      Doctor: [{ id: "doc_1", fullName: "Dr. Priya" }],
    });
    const twilioClient = createTwilioStub();

    await sendDelayedWorkflowMessage(
      { supabaseClient, twilioClient, clinicId: "clinic-1", appointmentId: "apt_1", workflowId: "review-2h-after" },
      null,
    );

    assert.match(twilioClient.calls.sendWhatsApp[0].body, /Please review us: https:\/\/g\.page\/r\/nirmaya-clinic\/review/);
  });

  test("skips as a no-op when a Reminder row already exists for this (appointmentId, workflowId)", async () => {
    const supabaseClient = createTableStub({
      Reminder: [{ id: "rem_1", appointmentId: "apt_1", type: "reminder-24h", channel: "whatsapp", status: "sent" }],
    });
    const twilioClient = createTwilioStub();

    await sendDelayedWorkflowMessage(
      { supabaseClient, twilioClient, clinicId: "clinic-1", appointmentId: "apt_1", workflowId: "reminder-24h" },
      null,
    );

    assert.equal(twilioClient.calls.sendWhatsApp.length, 0);
    assert.equal(supabaseClient._tables.Reminder.length, 1); // unchanged, no duplicate
  });

  test("skips when the appointment has no patient (a blocked-time entry)", async () => {
    const supabaseClient = createTableStub({
      Clinic: [makeClinic()],
      Appointment: [{ id: "apt_1", patientId: null, doctorId: "doc_1", timeslot: "2026-08-20T10:00:00" }],
    });
    const twilioClient = createTwilioStub();

    await sendDelayedWorkflowMessage(
      { supabaseClient, twilioClient, clinicId: "clinic-1", appointmentId: "apt_1", workflowId: "reminder-24h" },
      null,
    );

    assert.equal(twilioClient.calls.sendSms.length, 0);
    assert.equal(twilioClient.calls.sendWhatsApp.length, 0);
  });

  test("skips when the workflow no longer exists or is disabled in the clinic's current config", async () => {
    const supabaseClient = createTableStub({
      Clinic: [makeClinic({ settings: { communication: { channelsEnabled: ["sms"], workflows: [] } } })],
      Appointment: [{ id: "apt_1", patientId: "pat_1", doctorId: "doc_1", timeslot: "2026-08-20T10:00:00" }],
      Patient: [{ id: "pat_1", fullName: "Rahul", contactNumber: "+919888888888" }],
    });
    const twilioClient = createTwilioStub();

    await sendDelayedWorkflowMessage(
      { supabaseClient, twilioClient, clinicId: "clinic-1", appointmentId: "apt_1", workflowId: "reminder-24h" },
      null,
    );

    assert.equal(twilioClient.calls.sendSms.length, 0);
  });
});
