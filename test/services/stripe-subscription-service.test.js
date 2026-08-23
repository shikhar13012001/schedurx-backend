const { test, describe } = require("node:test");
const assert = require("node:assert/strict");

process.env.NODE_ENV = "test";
process.env.TOOLS_API_KEY = "test-tools-api-key-with-32-characters";
process.env.INTERNAL_API_KEY = "test-internal-api-key-with-32-chars";
process.env.SUPABASE_URL = "https://example.supabase.co";
process.env.SUPABASE_SERVICE_ROLE_KEY = "service-role-key";
process.env.NETTU_BASE_URL = "https://nettu.example.test";
process.env.NETTU_API_KEY = "nettu-api-key";
// Deliberately configured for basic/premium/one addon, left unset for
// custom-base and the rest — exercises both the "configured" and
// "STRIPE_PRICE_NOT_CONFIGURED" paths without fabricating every id.
process.env.STRIPE_PRICE_BASIC = "price_basic_test";
process.env.STRIPE_PRICE_PREMIUM = "price_premium_test";
process.env.STRIPE_PRICE_ADDON_AI_WHATSAPP_AGENT = "price_addon_wa_test";

const plansSvc = require("../../src/lib/plans");
const stripeSubSvc = require("../../src/services/stripe-subscription-service");
const { createTableStub } = require("../helpers/supabase-table-stub");
const { createStripeStub } = require("../helpers/stripe-stub");

describe("plans.stripePriceIdFor / missingStripePriceIds", () => {
  test("returns the configured price id for a plan with one set", () => {
    assert.equal(plansSvc.stripePriceIdFor("basic"), "price_basic_test");
  });

  test("returns null for a plan/addon with no price id configured", () => {
    assert.equal(plansSvc.stripePriceIdFor("custom"), null);
  });

  test("missingStripePriceIds reports nothing missing when fully configured", () => {
    assert.deepEqual(plansSvc.missingStripePriceIds("premium"), []);
  });

  test("missingStripePriceIds reports the custom base and any unconfigured addon", () => {
    const missing = plansSvc.missingStripePriceIds("custom", ["ai_whatsapp_agent", "smart_ivr"]);
    assert.deepEqual(missing.sort(), ["custom", "smart_ivr"].sort());
  });
});

describe("getOrCreateCustomer", () => {
  test("creates and persists a Stripe customer when the clinic has none", async () => {
    const supabaseClient = createTableStub({ Clinic: [{ id: "clinic-1", name: "Nirmaya Clinic", email: "a@b.com" }] });
    const stripeClient = createStripeStub({ customer: { id: "cus_new_1" } });

    const id = await stripeSubSvc.getOrCreateCustomer(stripeClient, supabaseClient, { id: "clinic-1", name: "Nirmaya Clinic" });

    assert.equal(id, "cus_new_1");
    assert.equal(supabaseClient._tables.Clinic[0].stripeCustomerId, "cus_new_1");
  });

  test("returns the existing customer id without calling Stripe again", async () => {
    const supabaseClient = createTableStub({ Clinic: [{ id: "clinic-1", stripeCustomerId: "cus_existing" }] });
    const stripeClient = createStripeStub({
      customer: { id: "SHOULD_NOT_BE_USED" },
    });

    const id = await stripeSubSvc.getOrCreateCustomer(stripeClient, supabaseClient, {
      id: "clinic-1",
      stripeCustomerId: "cus_existing",
    });

    assert.equal(id, "cus_existing");
  });
});

describe("createSubscriptionCheckoutSession", () => {
  test("builds one line item for a fixed plan", async () => {
    let capturedParams;
    const stripeClient = createStripeStub();
    stripeClient.checkout.sessions.create = async (params) => {
      capturedParams = params;
      return { id: "cs_1", url: "https://checkout.stripe.com/test" };
    };

    await stripeSubSvc.createSubscriptionCheckoutSession(stripeClient, {
      customerId: "cus_1",
      clinicId: "clinic-1",
      planId: "premium",
      addonIds: [],
      successUrl: "https://app/success",
      cancelUrl: "https://app/cancel",
    });

    assert.equal(capturedParams.mode, "subscription");
    assert.deepEqual(capturedParams.line_items, [{ price: "price_premium_test", quantity: 1 }]);
    assert.equal(capturedParams.metadata.planId, "premium");
  });

  test("builds a base + addon line item for the custom plan", async () => {
    let capturedParams;
    const stripeClient = createStripeStub();
    stripeClient.checkout.sessions.create = async (params) => {
      capturedParams = params;
      return { id: "cs_2", url: "https://checkout.stripe.com/test" };
    };

    await stripeSubSvc.createSubscriptionCheckoutSession(stripeClient, {
      customerId: "cus_1",
      clinicId: "clinic-1",
      planId: "custom",
      addonIds: ["ai_whatsapp_agent"],
      successUrl: "https://app/success",
      cancelUrl: "https://app/cancel",
    });

    assert.deepEqual(capturedParams.line_items, [
      { price: null, quantity: 1 }, // STRIPE_PRICE_CUSTOM_BASE deliberately unset in this test file
      { price: "price_addon_wa_test", quantity: 1 },
    ]);
  });
});

describe("addAddonItem / removeAddonItem", () => {
  function clinicRow(overrides = {}) {
    return { id: "clinic-1", stripeSubscriptionId: "sub_1", plan: { planId: "custom", addonIds: [] }, subscriptionItems: {}, ...overrides };
  }

  test("adds a new subscription item and tracks it on the Clinic row", async () => {
    const supabaseClient = createTableStub({ Clinic: [clinicRow()] });
    const stripeClient = createStripeStub({ subscriptionItem: { id: "si_wa_1" } });

    const items = await stripeSubSvc.addAddonItem(stripeClient, supabaseClient, clinicRow(), "ai_whatsapp_agent");

    assert.equal(items.addons.ai_whatsapp_agent.itemId, "si_wa_1");
    assert.equal(supabaseClient._tables.Clinic[0].subscriptionItems.addons.ai_whatsapp_agent.itemId, "si_wa_1");
  });

  test("refuses to add an addon with no Stripe Price configured", async () => {
    const supabaseClient = createTableStub({ Clinic: [clinicRow()] });
    const stripeClient = createStripeStub();

    await assert.rejects(
      () => stripeSubSvc.addAddonItem(stripeClient, supabaseClient, clinicRow(), "smart_ivr"),
      /STRIPE_PRICE_NOT_CONFIGURED|No Stripe Price configured/,
    );
  });

  test("refuses to add an addon when the clinic has no active subscription", async () => {
    const supabaseClient = createTableStub({ Clinic: [clinicRow({ stripeSubscriptionId: null })] });
    const stripeClient = createStripeStub();

    await assert.rejects(
      () => stripeSubSvc.addAddonItem(stripeClient, supabaseClient, clinicRow({ stripeSubscriptionId: null }), "ai_whatsapp_agent"),
      /NO_SUBSCRIPTION|no active subscription/,
    );
  });

  test("is idempotent — adding an already-tracked addon doesn't create a second Stripe item", async () => {
    const existing = clinicRow({ subscriptionItems: { addons: { ai_whatsapp_agent: { itemId: "si_already", priceId: "price_addon_wa_test" } } } });
    const supabaseClient = createTableStub({ Clinic: [existing] });
    let createCalls = 0;
    const stripeClient = createStripeStub();
    stripeClient.subscriptionItems.create = async () => {
      createCalls += 1;
      return { id: "si_should_not_happen" };
    };

    const items = await stripeSubSvc.addAddonItem(stripeClient, supabaseClient, existing, "ai_whatsapp_agent");

    assert.equal(createCalls, 0);
    assert.equal(items.addons.ai_whatsapp_agent.itemId, "si_already");
  });

  test("removes a tracked addon's subscription item", async () => {
    const existing = clinicRow({ subscriptionItems: { addons: { ai_whatsapp_agent: { itemId: "si_1", priceId: "price_addon_wa_test" } } } });
    const supabaseClient = createTableStub({ Clinic: [existing] });
    const stripeClient = createStripeStub();

    const items = await stripeSubSvc.removeAddonItem(stripeClient, supabaseClient, existing, "ai_whatsapp_agent");

    assert.equal(items.addons.ai_whatsapp_agent, undefined);
    assert.deepEqual(stripeClient._deletedItemIds, ["si_1"]);
  });

  test("removing an addon that was never added is a no-op, not an error", async () => {
    const existing = clinicRow();
    const supabaseClient = createTableStub({ Clinic: [existing] });
    const stripeClient = createStripeStub();

    const items = await stripeSubSvc.removeAddonItem(stripeClient, supabaseClient, existing, "ai_whatsapp_agent");

    assert.deepEqual(stripeClient._deletedItemIds, []);
    assert.deepEqual(items, existing.subscriptionItems);
  });
});

describe("syncSubscriptionFromStripeObject", () => {
  test("first sync establishes the base item and writes Clinic.plan from subscription metadata", async () => {
    const supabaseClient = createTableStub({ Clinic: [{ id: "clinic-1", subscriptionItems: null, plan: null }] });
    const subscription = {
      id: "sub_1",
      status: "active",
      current_period_end: 1_800_000_000,
      metadata: { planId: "premium", addonIds: "[]" },
      items: { data: [{ id: "si_base_1", price: { id: "price_premium_test" }, current_period_end: 1_800_000_000 }] },
    };

    const updated = await stripeSubSvc.syncSubscriptionFromStripeObject(supabaseClient, "clinic-1", subscription);

    assert.equal(updated.stripeSubscriptionId, "sub_1");
    assert.equal(updated.subscriptionStatus, "active");
    assert.equal(updated.subscriptionItems.base.itemId, "si_base_1");
    assert.equal(updated.plan.planId, "premium");
    assert.equal(updated.plan.estimatedMonthlyPaise, plansSvc.PLANS.premium.monthlyPaise);
  });

  test("later syncs update status/period but never clobber addon items already tracked", async () => {
    const supabaseClient = createTableStub({
      Clinic: [
        {
          id: "clinic-1",
          plan: { planId: "custom", addonIds: ["ai_whatsapp_agent"] },
          subscriptionItems: {
            base: { itemId: "si_base_1", priceId: "price_custom_base", planId: "custom" },
            addons: { ai_whatsapp_agent: { itemId: "si_wa_1", priceId: "price_addon_wa_test" } },
          },
        },
      ],
    });
    const subscription = {
      id: "sub_1",
      status: "past_due",
      current_period_end: 1_900_000_000,
      metadata: { planId: "custom", addonIds: '["ai_whatsapp_agent"]' },
      items: { data: [{ id: "si_base_1", price: { id: "price_custom_base" }, current_period_end: 1_900_000_000 }] },
    };

    const updated = await stripeSubSvc.syncSubscriptionFromStripeObject(supabaseClient, "clinic-1", subscription);

    assert.equal(updated.subscriptionStatus, "past_due");
    assert.equal(updated.subscriptionItems.addons.ai_whatsapp_agent.itemId, "si_wa_1", "addon tracking must survive a later webhook sync");
  });

  test("a cancellation sync updates status without requiring items", async () => {
    const supabaseClient = createTableStub({
      Clinic: [{ id: "clinic-1", subscriptionItems: { base: { itemId: "si_base_1" }, addons: {} } }],
    });
    const subscription = { id: "sub_1", status: "canceled", current_period_end: null, items: { data: [] } };

    const updated = await stripeSubSvc.syncSubscriptionFromStripeObject(supabaseClient, "clinic-1", subscription);

    assert.equal(updated.subscriptionStatus, "canceled");
  });
});

describe("subscriptionSummary", () => {
  test("shapes a Clinic row into the GET /billing/subscription response", () => {
    const summary = stripeSubSvc.subscriptionSummary({
      plan: { planId: "custom", addonIds: ["ai_whatsapp_agent"] },
      stripeSubscriptionId: "sub_1",
      subscriptionStatus: "active",
      subscriptionCurrentPeriodEnd: "2026-09-01T00:00:00.000Z",
      stripeCustomerId: "cus_1",
      subscriptionItems: { base: {}, addons: { ai_whatsapp_agent: { itemId: "si_1" } } },
    });

    assert.deepEqual(summary, {
      plan: { planId: "custom", addonIds: ["ai_whatsapp_agent"] },
      stripeSubscriptionId: "sub_1",
      subscriptionStatus: "active",
      subscriptionCurrentPeriodEnd: "2026-09-01T00:00:00.000Z",
      addons: ["ai_whatsapp_agent"],
      hasStripeCustomer: true,
    });
  });

  test("handles a clinic with no subscription at all", () => {
    const summary = stripeSubSvc.subscriptionSummary({ id: "clinic-1" });
    assert.deepEqual(summary, {
      plan: null,
      stripeSubscriptionId: null,
      subscriptionStatus: null,
      subscriptionCurrentPeriodEnd: null,
      addons: [],
      hasStripeCustomer: false,
    });
  });
});
