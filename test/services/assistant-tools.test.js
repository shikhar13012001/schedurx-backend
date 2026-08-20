const { test, describe } = require("node:test");
const assert = require("node:assert/strict");

const { buildAssistantTools } = require("../../src/services/assistant-tools");
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
      { id: "pat-1", clinicId: CLINIC_ID, fullName: "Anita Rao" },
      { id: "pat-2", clinicId: CLINIC_ID, fullName: "Vikram Nair" },
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
