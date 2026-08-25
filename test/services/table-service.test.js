const { test, describe } = require("node:test");
const assert = require("node:assert/strict");

const tableSvc = require("../../src/services/table-service");
const { createTableStub } = require("../helpers/supabase-table-stub");

describe("findPatientByExactPhone", () => {
  test("matches regardless of raw formatting differences, as long as the real number is identical", async () => {
    const supabaseClient = createTableStub({
      Patient: [{ id: "pat-1", clinicId: "clinic-1", fullName: "Test Patient", contactNumber: "9876543210" }],
    });
    const result = await tableSvc.findPatientByExactPhone(supabaseClient, "clinic-1", "+91 98765 43210");
    assert.equal(result.id, "pat-1");
  });

  test("returns null (never throws) for an invalid phone", async () => {
    const supabaseClient = createTableStub({ Patient: [] });
    const result = await tableSvc.findPatientByExactPhone(supabaseClient, "clinic-1", "not-a-phone");
    assert.equal(result, null);
  });

  test("returns null when no patient at this clinic has that exact number", async () => {
    const supabaseClient = createTableStub({
      Patient: [{ id: "pat-1", clinicId: "clinic-1", fullName: "Test Patient", contactNumber: "+919876543210" }],
    });
    const result = await tableSvc.findPatientByExactPhone(supabaseClient, "clinic-1", "+919999999999");
    assert.equal(result, null);
  });

  test("scopes strictly to the given clinic", async () => {
    const supabaseClient = createTableStub({
      Patient: [{ id: "pat-1", clinicId: "clinic-2", fullName: "Different Clinic Patient", contactNumber: "+919876543210" }],
    });
    const result = await tableSvc.findPatientByExactPhone(supabaseClient, "clinic-1", "+919876543210");
    assert.equal(result, null);
  });
});

describe("listPatientsForClinic — visitsCount", () => {
  test("attaches a real per-patient visit count and most-recent visit date instead of always zero/blank", async () => {
    const supabaseClient = createTableStub({
      Patient: [
        { id: "pat-1", clinicId: "clinic-1", fullName: "Rahul", createdAt: "2026-01-01" },
        { id: "pat-2", clinicId: "clinic-1", fullName: "Anita", createdAt: "2026-01-02" },
      ],
      Visit: [
        { id: "visit-1", clinicId: "clinic-1", patientId: "pat-1", visitDate: "2026-08-01" },
        { id: "visit-2", clinicId: "clinic-1", patientId: "pat-1", visitDate: "2026-08-20" },
        { id: "visit-3", clinicId: "clinic-1", patientId: "pat-2", visitDate: "2026-08-15" },
      ],
    });
    const result = await tableSvc.listPatientsForClinic(supabaseClient, "clinic-1");
    const pat1 = result.find((p) => p.id === "pat-1");
    const pat2 = result.find((p) => p.id === "pat-2");
    assert.equal(pat1.visitsCount, 2);
    assert.equal(pat1.lastVisitDate, "2026-08-20");
    assert.equal(pat2.visitsCount, 1);
    assert.equal(pat2.lastVisitDate, "2026-08-15");
  });

  test("a patient with no visits gets visitsCount: 0 and lastVisitDate: null, not undefined", async () => {
    const supabaseClient = createTableStub({
      Patient: [{ id: "pat-1", clinicId: "clinic-1", fullName: "Rahul", createdAt: "2026-01-01" }],
      Visit: [],
    });
    const result = await tableSvc.listPatientsForClinic(supabaseClient, "clinic-1");
    assert.equal(result[0].visitsCount, 0);
    assert.equal(result[0].lastVisitDate, null);
  });

  test("a visit from a different clinic never leaks into another clinic's count", async () => {
    const supabaseClient = createTableStub({
      Patient: [{ id: "pat-1", clinicId: "clinic-1", fullName: "Rahul", createdAt: "2026-01-01" }],
      Visit: [{ id: "visit-1", clinicId: "clinic-2", patientId: "pat-1" }],
    });
    const result = await tableSvc.listPatientsForClinic(supabaseClient, "clinic-1");
    assert.equal(result[0].visitsCount, 0);
  });

  test("an empty clinic returns [] without querying Visit", async () => {
    const supabaseClient = createTableStub({ Patient: [] });
    const result = await tableSvc.listPatientsForClinic(supabaseClient, "clinic-1");
    assert.deepEqual(result, []);
  });
});

describe("listAppointmentsForClinic — patientId filter", () => {
  test("scopes to one patient's full appointment history, including no-shows/cancelled, when patientId is given", async () => {
    const supabaseClient = createTableStub({
      Appointment: [
        { id: "apt-1", clinicId: "clinic-1", patientId: "pat-1", doctorId: "doc-1", timeslot: "2026-08-01T10:00:00", status: "completed" },
        { id: "apt-2", clinicId: "clinic-1", patientId: "pat-1", doctorId: "doc-1", timeslot: "2026-08-10T10:00:00", status: "no_show" },
        { id: "apt-3", clinicId: "clinic-1", patientId: "pat-1", doctorId: "doc-1", timeslot: "2026-08-15T10:00:00", status: "cancelled" },
        { id: "apt-4", clinicId: "clinic-1", patientId: "pat-2", doctorId: "doc-1", timeslot: "2026-08-05T10:00:00", status: "completed" },
      ],
    });
    const result = await tableSvc.listAppointmentsForClinic(supabaseClient, "clinic-1", { patientId: "pat-1" });
    assert.deepEqual(result.map((a) => a.id).sort(), ["apt-1", "apt-2", "apt-3"]);
  });

  test("without patientId, behaves exactly as before (no filter applied)", async () => {
    const supabaseClient = createTableStub({
      Appointment: [
        { id: "apt-1", clinicId: "clinic-1", patientId: "pat-1", doctorId: "doc-1", timeslot: "2026-08-01T10:00:00", status: "completed" },
        { id: "apt-2", clinicId: "clinic-1", patientId: "pat-2", doctorId: "doc-1", timeslot: "2026-08-05T10:00:00", status: "completed" },
      ],
    });
    const result = await tableSvc.listAppointmentsForClinic(supabaseClient, "clinic-1", {});
    assert.equal(result.length, 2);
  });
});
