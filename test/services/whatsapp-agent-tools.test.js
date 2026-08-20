const { test, describe } = require("node:test");
const assert = require("node:assert/strict");

const { buildPatientAgentTools } = require("../../src/services/whatsapp-agent-tools");
const { createTableStub } = require("../helpers/supabase-table-stub");

const CLINIC_ID = "poc-clinic-001";
const PATIENT_ID = "pat_caller";
const OTHER_PATIENT_ID = "pat_someone_else";
const THREAD_ID = "thread_1";

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
      {
        id: "doc-1",
        clinicId: CLINIC_ID,
        fullName: "Dr. Priya",
        isActive: true,
        schedulerDoctorId: "nettu-user-1",
        schedulerCalendarId: "nettu-cal-1",
      },
    ],
    Appointment: [
      {
        id: "apt_mine",
        clinicId: CLINIC_ID,
        patientId: PATIENT_ID,
        doctorId: "doc-1",
        timeslot: futureIso(24),
        status: "booked",
      },
      {
        id: "apt_mine_2",
        clinicId: CLINIC_ID,
        patientId: PATIENT_ID,
        doctorId: "doc-1",
        timeslot: futureIso(30),
        status: "booked",
      },
      {
        id: "apt_someone_elses",
        clinicId: CLINIC_ID,
        patientId: OTHER_PATIENT_ID,
        doctorId: "doc-1",
        timeslot: futureIso(48),
        status: "booked",
      },
      {
        id: "apt_mine_cancelled",
        clinicId: CLINIC_ID,
        patientId: PATIENT_ID,
        doctorId: "doc-1",
        timeslot: futureIso(72),
        status: "cancelled",
      },
    ],
    Visit: [{ id: "v1", clinicId: CLINIC_ID, patientId: PATIENT_ID, visitDate: "2026-01-01", diagnosis: "Flu" }],
    Thread: [{ id: THREAD_ID, clinicId: CLINIC_ID, status: "open" }],
    ...extra,
  };
}

function makeTools(supabaseClient, overrides = {}) {
  return buildPatientAgentTools({
    supabaseClient,
    nettuClient: {},
    twilioClient: {},
    clinicId: CLINIC_ID,
    patientId: PATIENT_ID,
    threadId: THREAD_ID,
    doctors: [{ id: "doc-1", fullName: "Dr. Priya" }],
    timezone: "Asia/Kolkata",
    log: null,
    ...overrides,
  });
}

describe("get_my_appointments", () => {
  test("returns only the caller's own, non-cancelled upcoming appointments", async () => {
    const tools = makeTools(createTableStub(makeTables()));
    const result = await tools.get_my_appointments.execute({});
    assert.equal(result.appointments.length, 2);
    assert.deepEqual(result.appointments.map((a) => a.appointmentId).sort(), ["apt_mine", "apt_mine_2"]);
    assert.equal(result.appointments[0].doctorName, "Dr. Priya");
  });

  test("status filter returns the caller's cancelled appointment instead of the default upcoming set", async () => {
    const tools = makeTools(createTableStub(makeTables()));
    const result = await tools.get_my_appointments.execute({ status: "cancelled" });
    assert.equal(result.appointments.length, 1);
    assert.equal(result.appointments[0].appointmentId, "apt_mine_cancelled");
  });
});

describe("get_my_visit_history", () => {
  test("returns the caller's own visits", async () => {
    const tools = makeTools(createTableStub(makeTables()));
    const result = await tools.get_my_visit_history.execute({});
    assert.equal(result.visits.length, 1);
    assert.equal(result.visits[0].diagnosis, "Flu");
  });
});

describe("ownership enforcement", () => {
  test("find_reschedule_slots refuses an appointment belonging to a different patient", async () => {
    const tools = makeTools(createTableStub(makeTables()));
    const result = await tools.find_reschedule_slots.execute({ appointmentId: "apt_someone_elses" });
    assert.equal(result.ok, false);
    assert.match(result.error, /doesn't belong/);
  });

  test("reschedule_my_appointments refuses an appointment belonging to a different patient", async () => {
    const tools = makeTools(createTableStub(makeTables()));
    const result = await tools.reschedule_my_appointments.execute({
      appointmentIds: ["apt_someone_elses"],
      date: "2026-08-25",
      time: "10:00",
    });
    assert.equal(result.succeeded, 0);
    assert.equal(result.failed, 1);
    assert.match(result.results[0].error, /doesn't belong/);
  });

  test("cancel_my_appointments refuses an appointment belonging to a different patient", async () => {
    const tables = makeTables();
    const supabaseClient = createTableStub(tables);
    const tools = makeTools(supabaseClient);
    const result = await tools.cancel_my_appointments.execute({ appointmentIds: ["apt_someone_elses"] });
    assert.equal(result.succeeded, 0);
    // Confirms the guard runs before any mutation — the other patient's
    // appointment must still be untouched.
    const { data: untouched } = await supabaseClient.from("Appointment").eq("id", "apt_someone_elses").maybeSingle();
    assert.equal(untouched.status, "booked");
  });

  test("cancel_my_appointments refuses an appointment from a different clinic even with a matching patientId", async () => {
    const tables = makeTables({
      Appointment: [
        { id: "apt_cross_clinic", clinicId: "some-other-clinic", patientId: PATIENT_ID, doctorId: "doc-1", timeslot: futureIso(24), status: "booked" },
      ],
    });
    const tools = makeTools(createTableStub(tables));
    const result = await tools.cancel_my_appointments.execute({ appointmentIds: ["apt_cross_clinic"] });
    assert.equal(result.succeeded, 0);
  });

  test("a bulk call with a mix of owned and not-owned ids cancels only the owned one, reporting both outcomes", async () => {
    const supabaseClient = createTableStub(makeTables());
    const tools = makeTools(supabaseClient, { nettuClient: makeNettuStub() });
    const result = await tools.cancel_my_appointments.execute({ appointmentIds: ["apt_mine", "apt_someone_elses"] });
    assert.equal(result.succeeded, 1);
    assert.equal(result.failed, 1);
    const mine = result.results.find((r) => r.appointmentId === "apt_mine");
    const theirs = result.results.find((r) => r.appointmentId === "apt_someone_elses");
    assert.equal(mine.ok, true);
    assert.equal(theirs.ok, false);
    const { data: theirsRow } = await supabaseClient.from("Appointment").eq("id", "apt_someone_elses").maybeSingle();
    assert.equal(theirsRow.status, "booked", "the not-owned appointment must be untouched");
    const { data: mineRow } = await supabaseClient.from("Appointment").eq("id", "apt_mine").maybeSingle();
    assert.equal(mineRow.status, "cancelled");
  });
});

describe("reschedule_my_appointments", () => {
  test("reschedules the caller's own appointment to a new time (single id)", async () => {
    const supabaseClient = createTableStub(makeTables());
    const tools = makeTools(supabaseClient, { nettuClient: makeNettuStub() });
    const future = new Date(Date.now() + 50 * 60 * 60 * 1000);
    const date = future.toISOString().slice(0, 10);
    const result = await tools.reschedule_my_appointments.execute({ appointmentIds: ["apt_mine"], date, time: "11:00" });
    assert.equal(result.succeeded, 1, JSON.stringify(result));
    const { data: updated } = await supabaseClient.from("Appointment").eq("id", "apt_mine").maybeSingle();
    assert.equal(updated.status, "booked");
  });

  test("bulk-reschedules multiple owned appointments with shiftByDays, each keeping its own time of day", async () => {
    const supabaseClient = createTableStub(makeTables());
    const tools = makeTools(supabaseClient, { nettuClient: makeNettuStub() });
    const result = await tools.reschedule_my_appointments.execute({ appointmentIds: ["apt_mine", "apt_mine_2"], shiftByDays: 1 });
    assert.equal(result.succeeded, 2, JSON.stringify(result));
    assert.equal(result.failed, 0);
  });

  test("rejects date/time when more than one appointmentId is given", async () => {
    const tools = makeTools(createTableStub(makeTables()), { nettuClient: makeNettuStub() });
    const result = await tools.reschedule_my_appointments.execute({
      appointmentIds: ["apt_mine", "apt_mine_2"],
      date: "2026-08-25",
      time: "10:00",
    });
    assert.equal(result.ok, false);
    assert.match(result.error, /only apply to a single/);
  });
});

describe("escalate_to_staff", () => {
  test("marks the thread escalated", async () => {
    const supabaseClient = createTableStub(makeTables());
    const tools = makeTools(supabaseClient);
    const result = await tools.escalate_to_staff.execute({ reason: "wants a new booking" });
    assert.equal(result.escalated, true);
    const { data: thread } = await supabaseClient.from("Thread").eq("id", THREAD_ID).maybeSingle();
    assert.equal(thread.status, "escalated");
  });
});
