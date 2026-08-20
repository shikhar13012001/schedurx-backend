const { test, describe } = require("node:test");
const assert = require("node:assert/strict");

const doctorSvc = require("../../src/services/doctor-service");
const { createTableStub } = require("../helpers/supabase-table-stub");

describe("createDoctor", () => {
  // Doctor.feeInr is a real NOT NULL column on the live table — confirmed
  // live (a null insert throws "violates not-null constraint"), and not
  // documented anywhere in this repo before this bug shipped: the
  // onboarding bootstrap creates a Doctor row before a fee is ever
  // collected (screen 2, fee isn't asked until screen 3), so createDoctor
  // must never pass feeInr through as null.
  test("defaults feeInr to 0 instead of null when not provided", async () => {
    const supabaseClient = createTableStub({});
    const doctor = await doctorSvc.createDoctor(supabaseClient, { clinicId: "clinic-1", fullName: "Dr. Test" });
    assert.equal(doctor.feeInr, 0);
    assert.notEqual(doctor.feeInr, null);
  });

  test("preserves an explicit feeInr value when one is given", async () => {
    const supabaseClient = createTableStub({});
    const doctor = await doctorSvc.createDoctor(supabaseClient, { clinicId: "clinic-1", fullName: "Dr. Test", feeInr: 800 });
    assert.equal(doctor.feeInr, 800);
  });

  test("preserves an explicit feeInr of 0", async () => {
    const supabaseClient = createTableStub({});
    const doctor = await doctorSvc.createDoctor(supabaseClient, { clinicId: "clinic-1", fullName: "Dr. Test", feeInr: 0 });
    assert.equal(doctor.feeInr, 0);
  });
});
