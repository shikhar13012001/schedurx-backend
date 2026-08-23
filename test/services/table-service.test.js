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
