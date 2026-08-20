const { test, describe } = require("node:test");
const assert = require("node:assert/strict");

const { estimateMonthlyPaise, entitlementsForPlan, validatePlanSelection, PLANS } = require("../../src/lib/plans");

describe("estimateMonthlyPaise", () => {
  test("basic plan is a fixed price with no add-ons", () => {
    assert.equal(estimateMonthlyPaise("basic"), PLANS.basic.monthlyPaise);
  });

  test("premium plan is a fixed price regardless of addonIds", () => {
    assert.equal(estimateMonthlyPaise("premium", ["ai_calling_agent"]), PLANS.premium.monthlyPaise);
  });

  test("custom plan sums base + selected add-ons correctly", () => {
    // Base 999 + AI Calling Agent 599 + AI WhatsApp 699 + Ambient Listening 1499 = 3796, in paise.
    const total = estimateMonthlyPaise("custom", ["ai_calling_agent", "ai_whatsapp_agent", "ambient_listening"]);
    assert.equal(total, 379600);
  });

  test("custom plan with no add-ons is just the base", () => {
    assert.equal(estimateMonthlyPaise("custom", []), PLANS.custom.basePaise);
  });

  test("throws on an unknown plan id", () => {
    assert.throws(() => estimateMonthlyPaise("enterprise"), /Unknown plan/);
  });

  test("throws on an unknown add-on id", () => {
    assert.throws(() => estimateMonthlyPaise("custom", ["time_travel"]), /Unknown add-on/);
  });
});

describe("entitlementsForPlan", () => {
  test("basic never grants AI voice or conversational WhatsApp", () => {
    const e = entitlementsForPlan("basic");
    assert.equal(e.aiInboundVoice, false);
    assert.equal(e.aiOutboundVoice, false);
    assert.equal(e.whatsappConversationalAi, false);
    assert.equal(e.missedCallSafetyNet, true, "the missed-call safety net is on every plan");
  });

  test("premium grants everything, including ambient listening", () => {
    const e = entitlementsForPlan("premium");
    assert.equal(e.aiInboundVoice, true);
    assert.equal(e.aiOutboundVoice, true);
    assert.equal(e.whatsappConversationalAi, true);
    assert.equal(e.ambientListening, true);
  });

  test("custom plan entitlements exactly track selected add-ons", () => {
    const withCalling = entitlementsForPlan("custom", ["ai_calling_agent"]);
    assert.equal(withCalling.aiInboundVoice, true);
    assert.equal(withCalling.whatsappConversationalAi, false, "WhatsApp add-on wasn't selected");

    const withNothing = entitlementsForPlan("custom", []);
    assert.equal(withNothing.aiInboundVoice, false);
    assert.equal(withNothing.missedCallSafetyNet, true, "still on by default even with zero add-ons");
  });
});

describe("validatePlanSelection", () => {
  test("accepts a bare basic/premium selection with no add-ons", () => {
    assert.doesNotThrow(() => validatePlanSelection({ planId: "basic", addonIds: [] }));
    assert.doesNotThrow(() => validatePlanSelection({ planId: "premium" }));
  });

  test("rejects add-ons attached to a non-custom plan", () => {
    assert.throws(
      () => validatePlanSelection({ planId: "basic", addonIds: ["ai_calling_agent"] }),
      /only apply to the 'custom' plan/,
    );
  });

  test("rejects an unknown add-on id on the custom plan", () => {
    assert.throws(() => validatePlanSelection({ planId: "custom", addonIds: ["not_real"] }), /Unknown add-on/);
  });

  test("rejects an unknown plan id", () => {
    assert.throws(() => validatePlanSelection({ planId: "enterprise" }), /Unknown plan/);
  });
});
