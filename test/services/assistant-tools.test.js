const { test, describe } = require("node:test");
const assert = require("node:assert/strict");

const { buildAssistantTools } = require("../../src/services/assistant-tools");
const { epochToISO } = require("../../src/services/availability-service");
const { createTableStub } = require("../helpers/supabase-table-stub");

const CLINIC_ID = "poc-clinic-001";
const OTHER_CLINIC_ID = "some-other-clinic";

function futureIso(hoursFromNow) {
  return new Date(Date.now() + hoursFromNow * 60 * 60 * 1000).toISOString();
}

function makeNettuStub() {
  return {
    async createEvent() {
      return { id: "nettu-event-new" };
    },
    async deleteEvent() {
      return { id: "nettu-event-old" };
    },
  };
}

function makeTables(extra = {}) {
  return {
    Clinic: [
      {
        id: CLINIC_ID,
        status: "active",
        schedulerServiceId: "svc-001",
        timezone: "Asia/Kolkata",
        workingDays: ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat"],
        openingHour: 9,
        closingHour: 18,
        defaultAppointmentDurationMins: 30,
        bufferMins: 5,
        minNoticeHours: 0,
        maxBookingWindowDays: 30,
        cancellationCutoffHours: 0,
        rescheduleCutoffHours: 0,
        settings: {},
      },
    ],
    Doctor: [
      { id: "doc-1", clinicId: CLINIC_ID, fullName: "Priya Sharma", isActive: true, schedulerDoctorId: "nettu-user-1", schedulerCalendarId: "nettu-cal-1" },
      { id: "doc-2", clinicId: CLINIC_ID, fullName: "Rahul Mehta", isActive: true, schedulerDoctorId: "nettu-user-2", schedulerCalendarId: "nettu-cal-2" },
    ],
    Patient: [
      { id: "pat-1", clinicId: CLINIC_ID, fullName: "Anita Rao", contactNumber: "+919876500001" },
      { id: "pat-2", clinicId: CLINIC_ID, fullName: "Vikram Nair", contactNumber: "+919876500002" },
      { id: "pat-3", clinicId: CLINIC_ID, fullName: "No Phone Patient", contactNumber: null },
    ],
    Appointment: [
      { id: "apt-1", clinicId: CLINIC_ID, doctorId: "doc-1", patientId: "pat-1", timeslot: futureIso(24), status: "booked" },
      { id: "apt-2", clinicId: CLINIC_ID, doctorId: "doc-1", patientId: "pat-2", timeslot: futureIso(30), status: "booked" },
      { id: "apt-3", clinicId: CLINIC_ID, doctorId: "doc-2", patientId: "pat-1", timeslot: futureIso(36), status: "tentative" },
      { id: "apt-other-clinic", clinicId: OTHER_CLINIC_ID, doctorId: "doc-1", patientId: "pat-1", timeslot: futureIso(24), status: "booked" },
    ],
    ...extra,
  };
}

function makeTools(supabaseClient, overrides = {}) {
  return buildAssistantTools({
    supabaseClient,
    nettuClient: {},
    twilioClient: {},
    clinicId: CLINIC_ID,
    staffId: "staff-1",
    timezone: "Asia/Kolkata",
    reminderDoctor: { id: "doc-1", fullName: "Priya Sharma" },
    log: null,
    ...overrides,
  });
}

describe("list_appointments", () => {
  test("lists every appointment for the clinic with patient names attached, across doctors", async () => {
    const tools = makeTools(createTableStub(makeTables()));
    const result = await tools.list_appointments.execute({});
    assert.equal(result.count, 3);
    const byId = Object.fromEntries(result.appointments.map((a) => [a.id, a]));
    assert.equal(byId["apt-1"].patientName, "Anita Rao");
    assert.equal(byId["apt-2"].patientName, "Vikram Nair");
  });

  // Live eval against the deployed assistant caught it reading the stored
  // UTC digits as-is and telling a staff member "01:07 AM (UTC)" — real,
  // reproduced-in-production bug, not hypothetical.
  test("start comes back in clinic-local time, not the bare stored UTC instant", async () => {
    const supabaseClient = createTableStub(makeTables({
      Appointment: [{ id: "apt-tz", clinicId: CLINIC_ID, doctorId: "doc-1", patientId: "pat-1", timeslot: "2026-08-23T01:07:21.933Z", status: "booked" }],
    }));
    const tools = makeTools(supabaseClient);
    const result = await tools.list_appointments.execute({});
    const appt = result.appointments.find((a) => a.id === "apt-tz");
    assert.match(appt.start, /^2026-08-23T06:37:21/); // 01:07 UTC + 5:30 = 06:37 IST
    assert.match(appt.start, /\+05:30$/);
  });

  test("filters by doctorId", async () => {
    const tools = makeTools(createTableStub(makeTables()));
    const result = await tools.list_appointments.execute({ doctorId: "doc-2" });
    assert.equal(result.count, 1);
    assert.equal(result.appointments[0].id, "apt-3");
  });

  test("filters by status", async () => {
    const tools = makeTools(createTableStub(makeTables()));
    const result = await tools.list_appointments.execute({ status: "tentative" });
    assert.equal(result.count, 1);
    assert.equal(result.appointments[0].id, "apt-3");
  });

  test("never returns another clinic's appointments", async () => {
    const tools = makeTools(createTableStub(makeTables()));
    const result = await tools.list_appointments.execute({});
    assert.ok(!result.appointments.some((a) => a.id === "apt-other-clinic"));
  });
});

describe("reschedule_appointments", () => {
  test("reschedules a single appointment with an absolute newStart", async () => {
    const supabaseClient = createTableStub(makeTables());
    const tools = makeTools(supabaseClient, { nettuClient: makeNettuStub() });
    const result = await tools.reschedule_appointments.execute({
      appointmentIds: ["apt-1"],
      newStart: new Date(Date.now() + 50 * 60 * 60 * 1000).toISOString(),
    });
    assert.equal(result.succeeded, 1, JSON.stringify(result));
    assert.equal(result.failed, 0);
  });

  test("bulk-reschedules multiple appointments with shiftByDays, each keeping its own time of day", async () => {
    const supabaseClient = createTableStub(makeTables());
    const tools = makeTools(supabaseClient, { nettuClient: makeNettuStub() });
    const result = await tools.reschedule_appointments.execute({ appointmentIds: ["apt-1", "apt-2"], shiftByDays: 1 });
    assert.equal(result.succeeded, 2, JSON.stringify(result));
    assert.equal(result.failed, 0);
  });

  test("rejects an absolute newStart when more than one appointmentId is given", async () => {
    const tools = makeTools(createTableStub(makeTables()), { nettuClient: makeNettuStub() });
    const result = await tools.reschedule_appointments.execute({
      appointmentIds: ["apt-1", "apt-2"],
      newStart: new Date(Date.now() + 50 * 60 * 60 * 1000).toISOString(),
    });
    assert.equal(result.succeeded, 0);
    assert.equal(result.failed, 2);
  });

  test("a bulk call mixing a real id with an unknown one reports both outcomes without failing the whole call", async () => {
    const supabaseClient = createTableStub(makeTables());
    const tools = makeTools(supabaseClient, { nettuClient: makeNettuStub() });
    const result = await tools.reschedule_appointments.execute({ appointmentIds: ["apt-1", "apt-does-not-exist"], shiftByDays: 1 });
    assert.equal(result.succeeded, 1);
    assert.equal(result.failed, 1);
    assert.match(result.results.find((r) => r.appointmentId === "apt-does-not-exist").error, /not found/i);
  });
});

describe("cancel_appointments", () => {
  test("cancels a single appointment", async () => {
    const supabaseClient = createTableStub(makeTables());
    const tools = makeTools(supabaseClient, { nettuClient: makeNettuStub() });
    const result = await tools.cancel_appointments.execute({ appointmentIds: ["apt-1"] });
    assert.equal(result.succeeded, 1, JSON.stringify(result));
    const { data: row } = await supabaseClient.from("Appointment").eq("id", "apt-1").maybeSingle();
    assert.equal(row.status, "cancelled");
  });

  test("bulk-cancels multiple appointments in one call", async () => {
    const supabaseClient = createTableStub(makeTables());
    const tools = makeTools(supabaseClient, { nettuClient: makeNettuStub() });
    const result = await tools.cancel_appointments.execute({ appointmentIds: ["apt-1", "apt-2", "apt-3"], reason: "Clinic closed" });
    assert.equal(result.succeeded, 3, JSON.stringify(result));
    assert.equal(result.failed, 0);
  });
});

describe("find_patient_history", () => {
  test("finds a patient by partial name and returns their visit history", async () => {
    const tools = makeTools(createTableStub(makeTables({
      Visit: [{ id: "visit-1", clinicId: CLINIC_ID, patientId: "pat-1", visitDate: "2026-08-01", symptoms: "Fever", diagnosis: "Flu", note: "Rest advised" }],
    })));
    const result = await tools.find_patient_history.execute({ query: "Anita" });
    assert.equal(result.found, true);
    assert.equal(result.patient.name, "Anita Rao");
    assert.equal(result.visits.length, 1);
    assert.equal(result.visits[0].diagnosis, "Flu");
  });

  test("reports not found for a name that matches nobody", async () => {
    const tools = makeTools(createTableStub(makeTables()));
    const result = await tools.find_patient_history.execute({ query: "Nobody Named This" });
    assert.equal(result.found, false);
    assert.deepEqual(result.matches, []);
  });

  test("empty query string doesn't crash and returns not-found rather than every patient", async () => {
    const tools = makeTools(createTableStub(makeTables()));
    const result = await tools.find_patient_history.execute({ query: "" });
    assert.equal(result.found, false);
  });
});

describe("add_task", () => {
  test("adds a task with a due date/time, resolved via the clinic's timezone", async () => {
    const supabaseClient = createTableStub(makeTables());
    const tools = makeTools(supabaseClient);
    const result = await tools.add_task.execute({ title: "Call the lab about an echo", dueDate: "2026-09-01", dueTime: "14:00" });
    assert.equal(result.added, true);
    assert.equal(result.title, "Call the lab about an echo");
  });

  test("adds a task with no due date at all", async () => {
    const tools = makeTools(createTableStub(makeTables()));
    const result = await tools.add_task.execute({ title: "Follow up with front desk" });
    assert.equal(result.added, true);
  });
});

describe("find_next_free_slot", () => {
  function makeSlotNettuStub(rawSlots) {
    return { async getBookingSlots() { return rawSlots; } };
  }

  test("returns up to 5 upcoming slots, dropping any nettu returned in the past", async () => {
    const past = Date.now() - 60 * 60 * 1000;
    const future = Date.now() + 3 * 60 * 60 * 1000;
    const tools = makeTools(createTableStub(makeTables()), {
      nettuClient: makeSlotNettuStub([
        { start: past, duration: 15 * 60 * 1000 },
        ...Array.from({ length: 6 }, (_, i) => ({ start: future + i * 15 * 60 * 1000, duration: 15 * 60 * 1000 })),
      ]),
    });
    const result = await tools.find_next_free_slot.execute({ doctorId: "doc-1" });
    assert.equal(result.slots.length, 5, JSON.stringify(result));
    assert.ok(result.slots.every((s) => new Date(s.start).getTime() > Date.now()));
  });

  // Finds a date string near "today" matching the target weekday, using the
  // exact same UTC-anchored weekday check availability-service.js's
  // nonWorkingDays computation uses — a local-timezone getDay() (as an
  // earlier version of this test used) can disagree with that near a day
  // boundary, exactly the class of bug this session already found and fixed
  // in the app itself (see api-v1-assistant.js's "already passed" fix).
  // Starts from TOMORROW, not today: resolveBookingWindow's minNoticeHours
  // clamp compares the requested day's UTC midnight against the precise
  // current instant, so "today" itself reads as already-past the moment any
  // time at all has elapsed today — a real (separate, pre-existing) product
  // question about same-day booking, not something this test is about.
  function nextDateWithWeekday(targetShort, { avoid = false } = {}) {
    let d = new Date(`${new Date().toISOString().slice(0, 10)}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() + 1);
    for (let i = 0; i < 14; i++) {
      const wd = d.toLocaleDateString("en-US", { weekday: "short", timeZone: "UTC" });
      if (avoid ? wd !== targetShort : wd === targetShort) return d.toISOString().slice(0, 10);
      d.setUTCDate(d.getUTCDate() + 1);
    }
    throw new Error(`no matching date found for ${targetShort}`);
  }

  test("flags a requested day the clinic isn't open on, instead of leaving an empty result unexplained", async () => {
    // makeTables' Clinic works Mon–Sat.
    const sunday = nextDateWithWeekday("Sun");
    const tools = makeTools(createTableStub(makeTables()), { nettuClient: makeSlotNettuStub([]) });
    const result = await tools.find_next_free_slot.execute({ doctorId: "doc-1", date: sunday });
    assert.equal(result.slots.length, 0);
    assert.deepEqual(result.nonWorkingDays, [sunday]);
  });

  test("a working day with genuinely no open slots reports empty with no nonWorkingDays hint", async () => {
    const workingDay = nextDateWithWeekday("Sun", { avoid: true });
    const tools = makeTools(createTableStub(makeTables()), { nettuClient: makeSlotNettuStub([]) });
    const result = await tools.find_next_free_slot.execute({ doctorId: "doc-1", date: workingDay });
    assert.equal(result.slots.length, 0);
    assert.equal(result.nonWorkingDays, undefined);
  });
});

describe("block_time", () => {
  test("blocks a window and cancels a real appointment it overlaps, without touching a non-overlapping one", async () => {
    const supabaseClient = createTableStub(makeTables());
    const tools = makeTools(supabaseClient, { nettuClient: makeNettuStub() });
    const apt1Before = await supabaseClient.from("Appointment").eq("id", "apt-1").maybeSingle();
    // apt-1's stored timeslot is a UTC instant — block_time takes a clinic-
    // LOCAL date/time (it converts via localToUtcISO itself), so this has to
    // go through the same Asia/Kolkata conversion, not a raw substring of
    // the UTC string (that was this test's own bug on the first pass: it
    // silently shifted the block ~5.5h earlier than apt-1's real start,
    // so they no longer overlapped and nothing got cancelled).
    const localIso = epochToISO(new Date(apt1Before.data.timeslot).getTime(), "Asia/Kolkata");
    const blockDate = localIso.slice(0, 10);
    const blockTime = localIso.slice(11, 16);

    const result = await tools.block_time.execute({ doctorId: "doc-1", date: blockDate, time: blockTime, minutes: 120, reason: "Emergency surgery" });
    assert.equal(result.blocked, true, JSON.stringify(result));

    const { data: apt1After } = await supabaseClient.from("Appointment").eq("id", "apt-1").maybeSingle();
    assert.equal(apt1After.status, "cancelled");

    // apt-3 is a different doctor at a different time — must be untouched.
    const { data: apt3After } = await supabaseClient.from("Appointment").eq("id", "apt-3").maybeSingle();
    assert.equal(apt3After.status, "tentative");
  });

  test("an unparseable date/time reports a clean error instead of throwing", async () => {
    const tools = makeTools(createTableStub(makeTables()), { nettuClient: makeNettuStub() });
    const result = await tools.block_time.execute({ doctorId: "doc-1", date: "not-a-date", time: "25:99", minutes: 60 });
    assert.equal(result.blocked, false);
    assert.ok(result.error);
  });
});

function makeTwilioStub() {
  const sent = [];
  return {
    sent,
    async sendWhatsApp({ to, body }) {
      sent.push({ channel: "whatsapp", to, body });
      return { sid: "SM-whatsapp-1" };
    },
    async sendSms({ to, body }) {
      sent.push({ channel: "sms", to, body });
      return { sid: "SM-sms-1" };
    },
  };
}

function threadRow(overrides = {}) {
  return {
    id: "thread-1", clinicId: CLINIC_ID, patientId: "pat-1", channel: "whatsapp",
    contactPhone: "+919876500001", status: "open", assignedStaffId: null,
    lastMessageAt: new Date().toISOString(), unreadCount: 2,
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

describe("list_patient_conversations", () => {
  test("lists open conversations with patient names attached", async () => {
    const tools = makeTools(createTableStub(makeTables({ Thread: [threadRow()] })));
    const result = await tools.list_patient_conversations.execute({});
    assert.equal(result.count, 1);
    assert.equal(result.threads[0].patientName, "Anita Rao");
    assert.equal(result.threads[0].unreadCount, 2);
  });

  test("onlyUnread excludes a read thread", async () => {
    const tools = makeTools(createTableStub(makeTables({
      Thread: [threadRow({ id: "thread-read", unreadCount: 0 }), threadRow({ id: "thread-unread", patientId: "pat-2", unreadCount: 1 })],
    })));
    const result = await tools.list_patient_conversations.execute({ onlyUnread: true });
    assert.equal(result.count, 1);
    assert.equal(result.threads[0].threadId, "thread-unread");
  });

  test("never lists a closed conversation", async () => {
    const tools = makeTools(createTableStub(makeTables({ Thread: [threadRow({ status: "closed" })] })));
    const result = await tools.list_patient_conversations.execute({});
    assert.equal(result.count, 0);
  });
});

describe("send_message_to_patient", () => {
  test("sends into an existing open WhatsApp thread when one exists", async () => {
    const supabaseClient = createTableStub(makeTables({ Thread: [threadRow()] }));
    const twilioClient = makeTwilioStub();
    const tools = makeTools(supabaseClient, { twilioClient });
    const result = await tools.send_message_to_patient.execute({ patientName: "Anita", message: "Your reports are ready." });
    assert.equal(result.sent, true, JSON.stringify(result));
    assert.equal(result.channel, "whatsapp");
    assert.equal(twilioClient.sent[0].channel, "whatsapp");
    assert.equal(twilioClient.sent[0].to, "+919876500001");
  });

  test("falls back to SMS when no open WhatsApp thread exists — never sends a cold WhatsApp message", async () => {
    const supabaseClient = createTableStub(makeTables());
    const twilioClient = makeTwilioStub();
    const tools = makeTools(supabaseClient, { twilioClient });
    const result = await tools.send_message_to_patient.execute({ patientName: "Vikram", message: "Reminder to bring your reports." });
    assert.equal(result.sent, true, JSON.stringify(result));
    assert.equal(result.channel, "sms");
    assert.equal(twilioClient.sent[0].channel, "sms");
  });

  test("falls back to SMS rather than reusing a closed WhatsApp thread", async () => {
    const supabaseClient = createTableStub(makeTables({ Thread: [threadRow({ status: "closed" })] }));
    const twilioClient = makeTwilioStub();
    const tools = makeTools(supabaseClient, { twilioClient });
    const result = await tools.send_message_to_patient.execute({ patientName: "Anita", message: "Hello again." });
    assert.equal(result.channel, "sms");
  });

  test("reports a clean error for a patient with no phone on file", async () => {
    const tools = makeTools(createTableStub(makeTables()), { twilioClient: makeTwilioStub() });
    const result = await tools.send_message_to_patient.execute({ patientName: "No Phone", message: "Hi" });
    assert.equal(result.sent, false);
    assert.match(result.error, /no phone number/i);
  });

  test("reports a clean error when no patient matches", async () => {
    const tools = makeTools(createTableStub(makeTables()), { twilioClient: makeTwilioStub() });
    const result = await tools.send_message_to_patient.execute({ patientName: "Nobody Here", message: "Hi" });
    assert.equal(result.sent, false);
    assert.match(result.error, /no patient/i);
  });
});

describe("notify_appointment_delay", () => {
  // The "today" computation's IST-vs-UTC day-boundary bug (live eval against
  // the deployed assistant caught it silently finding zero appointments
  // during the IST evening/night window where the UTC calendar date has
  // already rolled to "tomorrow") isn't covered by a mocked-clock test here
  // — node:test's global Date mock reliably leaked into sibling tests in
  // this file regardless of enable/setTime/reset teardown, making that
  // approach itself flaky. The fix (toLocaleDateString with the clinic's
  // timezone, matching the identical pattern already used and tested in
  // api-v1-assistant.js's systemPromptFor) was instead verified directly
  // against the live deployed assistant with a real appointment stored
  // under this exact boundary condition.

  // A bare "+N minutes from now" can drift past IST midnight depending on
  // real wall-clock time when the test happens to run — correctly excluded
  // by notify_appointment_delay's own day-boundary logic (that's the point
  // of the fix above), but this test wants both fixtures to reliably land
  // "today" regardless of when it runs, so clamp to a few minutes before
  // the clinic's actual local midnight if the naive offset would cross it.
  function minutesFromNowStayingWithinIstToday(minutes) {
    const naive = Date.now() + minutes * 60 * 1000;
    const istMidnightTonight = new Date(
      `${new Date(Date.now() + 5.5 * 60 * 60 * 1000).toISOString().slice(0, 10)}T18:30:00.000Z`, // next IST midnight, in UTC
    ).getTime();
    return new Date(Math.min(naive, istMidnightTonight - 5 * 60 * 1000)).toISOString();
  }

  test("notifies every upcoming patient for the doctor today by default", async () => {
    const soon = minutesFromNowStayingWithinIstToday(30);
    const later = minutesFromNowStayingWithinIstToday(90);
    const supabaseClient = createTableStub(makeTables({
      Appointment: [
        { id: "today-1", clinicId: CLINIC_ID, doctorId: "doc-1", patientId: "pat-1", timeslot: soon, status: "booked" },
        { id: "today-2", clinicId: CLINIC_ID, doctorId: "doc-1", patientId: "pat-2", timeslot: later, status: "tentative" },
        // A different doctor's patient today must not be notified.
        { id: "today-3", clinicId: CLINIC_ID, doctorId: "doc-2", patientId: "pat-1", timeslot: later, status: "booked" },
      ],
    }));
    const twilioClient = makeTwilioStub();
    const tools = makeTools(supabaseClient, { twilioClient });
    const result = await tools.notify_appointment_delay.execute({ doctorId: "doc-1", minutesLate: 20 });
    assert.equal(result.notified, 2, JSON.stringify(result));
    assert.equal(twilioClient.sent.length, 2);
    assert.ok(twilioClient.sent.every((m) => m.channel === "sms"));
    assert.ok(twilioClient.sent.every((m) => m.body.includes("20 min")));
  });

  test("notifies only the named patient when patientName is given", async () => {
    const soon = new Date(Date.now() + 30 * 60 * 1000).toISOString();
    const supabaseClient = createTableStub(makeTables({
      Appointment: [
        { id: "today-1", clinicId: CLINIC_ID, doctorId: "doc-1", patientId: "pat-1", timeslot: soon, status: "booked" },
        { id: "today-2", clinicId: CLINIC_ID, doctorId: "doc-1", patientId: "pat-2", timeslot: soon, status: "booked" },
      ],
    }));
    const twilioClient = makeTwilioStub();
    const tools = makeTools(supabaseClient, { twilioClient });
    const result = await tools.notify_appointment_delay.execute({ doctorId: "doc-1", minutesLate: 10, patientName: "Vikram" });
    assert.equal(result.notified, 1, JSON.stringify(result));
    assert.equal(twilioClient.sent[0].to, "+919876500002");
  });

  test("reports a clean error when nobody is left to notify today", async () => {
    const tools = makeTools(createTableStub(makeTables()), { twilioClient: makeTwilioStub() });
    const result = await tools.notify_appointment_delay.execute({ doctorId: "doc-1", minutesLate: 15 });
    assert.equal(result.notified, 0);
    assert.ok(result.error);
  });

  test("reports a clean error when the named patient has no upcoming appointment with this doctor", async () => {
    const tools = makeTools(createTableStub(makeTables()), { twilioClient: makeTwilioStub() });
    const result = await tools.notify_appointment_delay.execute({ doctorId: "doc-1", minutesLate: 15, patientName: "Anita" });
    assert.equal(result.notified, 0);
    assert.match(result.error, /no upcoming appointment/i);
  });
});
