const { test, describe } = require("node:test");
const assert = require("node:assert/strict");

const clinicSvc = require("../../src/services/clinic-service");
const { createTableStub } = require("../helpers/supabase-table-stub");

describe("advanceClinicOnboardingStep", () => {
  test("accepts the 'payment' step (Phase 2: inserted between 'plan' and 'calls')", async () => {
    const supabaseClient = createTableStub({ Clinic: [{ id: "clinic-1", onboardingStep: "plan" }] });
    await clinicSvc.advanceClinicOnboardingStep(supabaseClient, "clinic-1", "payment");
    assert.equal(supabaseClient._tables.Clinic[0].onboardingStep, "payment");
  });

  test("rejects an unknown step", async () => {
    const supabaseClient = createTableStub({ Clinic: [{ id: "clinic-1", onboardingStep: "plan" }] });
    await assert.rejects(
      () => clinicSvc.advanceClinicOnboardingStep(supabaseClient, "clinic-1", "not-a-real-step"),
      /INVALID_STEP|Invalid onboarding step/,
    );
  });
});
