const { test, describe } = require("node:test");
const assert = require("node:assert/strict");

const { listQueue, addWalkIn, advance, listPossibleNoShows } = require("../../src/services/queue-service");
const { createTableStub } = require("../helpers/supabase-table-stub");

describe("addWalkIn", () => {
  test("a genuine walk-in (no appointmentId) is tagged walkIn:true, as before", async () => {
    const supabaseClient = createTableStub();
    const item = await addWalkIn(supabaseClient, {
      clinicId: "clinic-1",
      doctorId: "doc-1",
      displayName: "Guest",
      phoneNumber: "+919888888888",
    });
    assert.equal(item.walkIn, true);
    assert.equal(item.status, "waiting");
    assert.equal(item.appointmentId, null);
  });

  test("checking in a booked appointment derives doctorId/patientId from the appointment, ignoring the client's, and tags walkIn:false", async () => {
    const supabaseClient = createTableStub({
      Appointment: [{ id: "apt_1", clinicId: "clinic-1", doctorId: "doc-real", patientId: "pat-real", status: "booked" }],
    });
    const item = await addWalkIn(supabaseClient, {
      clinicId: "clinic-1",
      doctorId: "doc-WRONG",
      patientId: "pat-WRONG",
      appointmentId: "apt_1",
    });
    assert.equal(item.walkIn, false);
    assert.equal(item.doctorId, "doc-real");
    assert.equal(item.patientId, "pat-real");
    assert.equal(item.appointmentId, "apt_1");
  });

  test("throws APPOINTMENT_NOT_FOUND for an unknown appointmentId", async () => {
    const supabaseClient = createTableStub({ Appointment: [] });
    await assert.rejects(
      () => addWalkIn(supabaseClient, { clinicId: "clinic-1", appointmentId: "nope" }),
      (err) => { assert.equal(err.code, "APPOINTMENT_NOT_FOUND"); return true; },
    );
  });

  test("throws APPOINTMENT_NOT_FOUND when the appointment belongs to a different clinic", async () => {
    const supabaseClient = createTableStub({
      Appointment: [{ id: "apt_1", clinicId: "other-clinic", doctorId: "doc-1", patientId: "pat-1", status: "booked" }],
    });
    await assert.rejects(
      () => addWalkIn(supabaseClient, { clinicId: "clinic-1", appointmentId: "apt_1" }),
      (err) => { assert.equal(err.code, "APPOINTMENT_NOT_FOUND"); return true; },
    );
  });

  test("throws APPOINTMENT_NOT_BOOKED when the appointment isn't in 'booked' status", async () => {
    const supabaseClient = createTableStub({
      Appointment: [{ id: "apt_1", clinicId: "clinic-1", doctorId: "doc-1", patientId: "pat-1", status: "cancelled" }],
    });
    await assert.rejects(
      () => addWalkIn(supabaseClient, { clinicId: "clinic-1", appointmentId: "apt_1" }),
      (err) => { assert.equal(err.code, "APPOINTMENT_NOT_BOOKED"); return true; },
    );
  });

  test("throws ALREADY_CHECKED_IN when a non-done queue entry already exists for this appointment", async () => {
    const supabaseClient = createTableStub({
      Appointment: [{ id: "apt_1", clinicId: "clinic-1", doctorId: "doc-1", patientId: "pat-1", status: "booked" }],
      QueueItem: [{ id: "q_1", clinicId: "clinic-1", doctorId: "doc-1", appointmentId: "apt_1", status: "waiting", position: 1 }],
    });
    await assert.rejects(
      () => addWalkIn(supabaseClient, { clinicId: "clinic-1", appointmentId: "apt_1" }),
      (err) => { assert.equal(err.code, "ALREADY_CHECKED_IN"); return true; },
    );
  });

  test("allows check-in when the only prior queue entry for this appointment is already 'done'", async () => {
    // e.g. a same-day rebooking after an earlier visit — shouldn't look "already checked in" forever.
    const supabaseClient = createTableStub({
      Appointment: [{ id: "apt_1", clinicId: "clinic-1", doctorId: "doc-1", patientId: "pat-1", status: "booked" }],
      QueueItem: [{ id: "q_old", clinicId: "clinic-1", doctorId: "doc-1", appointmentId: "apt_1", status: "done", position: 1 }],
    });
    const item = await addWalkIn(supabaseClient, { clinicId: "clinic-1", appointmentId: "apt_1" });
    assert.equal(item.status, "waiting");
  });
});

describe("advance — syncing the linked appointment", () => {
  function seed() {
    return createTableStub({
      Appointment: [{ id: "apt_1", clinicId: "clinic-1", status: "booked", auditHistory: [] }],
      QueueItem: [
        { id: "q_1", clinicId: "clinic-1", doctorId: "doc-1", appointmentId: "apt_1", status: "in_room", position: 1 },
      ],
    });
  }

  test("'next' flips the outgoing entry's linked appointment to completed", async () => {
    const supabaseClient = seed();
    await advance(supabaseClient, { clinicId: "clinic-1", doctorId: "doc-1", direction: "next" });
    assert.equal(supabaseClient._tables.QueueItem[0].status, "done");
    assert.equal(supabaseClient._tables.Appointment[0].status, "completed");
  });

  test("'next' still works for a queue entry with no linked appointment (a real walk-in)", async () => {
    const supabaseClient = createTableStub({
      QueueItem: [{ id: "q_1", clinicId: "clinic-1", doctorId: "doc-1", appointmentId: null, status: "in_room", position: 1 }],
    });
    const { nowServing } = await advance(supabaseClient, { clinicId: "clinic-1", doctorId: "doc-1", direction: "next" });
    assert.equal(nowServing, null);
    assert.equal(supabaseClient._tables.QueueItem[0].status, "done");
  });

  test("'prev' reverts a resurrected done entry's appointment back to booked", async () => {
    const supabaseClient = createTableStub({
      Appointment: [{ id: "apt_1", clinicId: "clinic-1", status: "completed", auditHistory: [] }],
      QueueItem: [
        {
          id: "q_1", clinicId: "clinic-1", doctorId: "doc-1", appointmentId: "apt_1",
          status: "done", position: 1, completedAt: new Date().toISOString(),
        },
      ],
    });
    await advance(supabaseClient, { clinicId: "clinic-1", doctorId: "doc-1", direction: "prev" });
    assert.equal(supabaseClient._tables.QueueItem[0].status, "in_room");
    assert.equal(supabaseClient._tables.Appointment[0].status, "booked");
  });
});

describe("listPossibleNoShows", () => {
  const HOUR_MS = 60 * 60_000;

  function apptRow(overrides = {}) {
    return {
      id: "apt_1", clinicId: "clinic-1", doctorId: "doc-1", patientId: "pat-1",
      status: "booked", timeslot: new Date(Date.now() - HOUR_MS).toISOString(), // 1h ago
      ...overrides,
    };
  }

  test("includes a booked appointment whose start passed the grace period with no check-in", async () => {
    const supabaseClient = createTableStub({ Appointment: [apptRow()], QueueItem: [] });
    const result = await listPossibleNoShows(supabaseClient, "clinic-1", { graceMinutes: 20 });
    assert.equal(result.length, 1);
    assert.equal(result[0].id, "apt_1");
  });

  test("excludes an appointment still within the grace period", async () => {
    const supabaseClient = createTableStub({
      Appointment: [apptRow({ timeslot: new Date(Date.now() - 5 * 60_000).toISOString() })], // 5 min ago
      QueueItem: [],
    });
    const result = await listPossibleNoShows(supabaseClient, "clinic-1", { graceMinutes: 20 });
    assert.equal(result.length, 0);
  });

  test("excludes an appointment beyond the lookback window (stale/ancient, not today's problem)", async () => {
    const supabaseClient = createTableStub({
      Appointment: [apptRow({ timeslot: new Date(Date.now() - 48 * HOUR_MS).toISOString() })],
      QueueItem: [],
    });
    const result = await listPossibleNoShows(supabaseClient, "clinic-1", { graceMinutes: 20 });
    assert.equal(result.length, 0);
  });

  test("excludes an appointment that already has a queue entry (checked in, even if still waiting/in_room)", async () => {
    const supabaseClient = createTableStub({
      Appointment: [apptRow()],
      QueueItem: [{ id: "q_1", clinicId: "clinic-1", doctorId: "doc-1", appointmentId: "apt_1", status: "waiting", position: 1 }],
    });
    const result = await listPossibleNoShows(supabaseClient, "clinic-1", { graceMinutes: 20 });
    assert.equal(result.length, 0);
  });

  test("excludes appointments not in 'booked' status (cancelled, blocked, already resolved)", async () => {
    const supabaseClient = createTableStub({
      Appointment: [apptRow({ id: "apt_c", status: "cancelled" }), apptRow({ id: "apt_b", status: "blocked" })],
      QueueItem: [],
    });
    const result = await listPossibleNoShows(supabaseClient, "clinic-1", { graceMinutes: 20 });
    assert.equal(result.length, 0);
  });

  test("filters by doctorId when given", async () => {
    const supabaseClient = createTableStub({
      Appointment: [apptRow({ id: "apt_a", doctorId: "doc-a" }), apptRow({ id: "apt_b", doctorId: "doc-b" })],
      QueueItem: [],
    });
    const result = await listPossibleNoShows(supabaseClient, "clinic-1", { doctorId: "doc-a", graceMinutes: 20 });
    assert.deepEqual(result.map((r) => r.id), ["apt_a"]);
  });

  test("uses the default grace period when none is given", async () => {
    const supabaseClient = createTableStub({
      Appointment: [apptRow({ timeslot: new Date(Date.now() - 5 * 60_000).toISOString() })], // 5 min ago
      QueueItem: [],
    });
    const result = await listPossibleNoShows(supabaseClient, "clinic-1", {});
    assert.equal(result.length, 0); // default (20min) grace hasn't passed yet
  });
});
