const { test, describe } = require("node:test");
const assert = require("node:assert/strict");

const staffSvc = require("../../src/services/staff-service");
const { createTableStub } = require("../helpers/supabase-table-stub");

describe("deactivateStaff", () => {
  test("sets isActive false for a staff member in the caller's own clinic", async () => {
    const supabaseClient = createTableStub({
      Staff: [{ id: "staff-1", clinicId: "clinic-1", role: "receptionist", isActive: true }],
    });
    const staff = await staffSvc.deactivateStaff(supabaseClient, "clinic-1", "staff-1");
    assert.equal(staff.isActive, false);
    const { data: row } = await supabaseClient.from("Staff").eq("id", "staff-1").maybeSingle();
    assert.equal(row.isActive, false);
  });

  // Tenant isolation: an owner from one clinic must not be able to
  // deactivate a staff member belonging to a different clinic just by
  // guessing/knowing their staffId.
  test("refuses to deactivate a staff member in a different clinic", async () => {
    const supabaseClient = createTableStub({
      Staff: [{ id: "staff-1", clinicId: "other-clinic", role: "receptionist", isActive: true }],
    });
    await assert.rejects(
      () => staffSvc.deactivateStaff(supabaseClient, "clinic-1", "staff-1"),
      /not found/i,
    );
    const { data: row } = await supabaseClient.from("Staff").eq("id", "staff-1").maybeSingle();
    assert.equal(row.isActive, true, "the other clinic's staff row must be untouched");
  });

  test("rejects an unknown staffId", async () => {
    const supabaseClient = createTableStub({ Staff: [] });
    await assert.rejects(() => staffSvc.deactivateStaff(supabaseClient, "clinic-1", "nope"), /not found/i);
  });
});
