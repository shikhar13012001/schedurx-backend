// Recurring subscription billing — deliberately a sibling to
// stripe-service.js, not merged into it: that file's shapes (one-off
// Checkout Session, Invoice marking) are structurally different from a
// subscription's ongoing lifecycle (Customer, subscription items, Billing
// Portal, webhook-driven status sync), and conflating the two would make
// both harder to read.
//
// Addon deltas (Phase 2's resolved design decision): the Stripe Customer
// Portal's "switch plan" feature swaps a subscription between a configured
// list of whole Products/Prices (or updates one item's quantity) — it has no
// concept of independently adding/removing individual line items on a
// multi-item subscription (confirmed against Stripe's Portal configuration
// docs/API: `subscription_update.default_allowed_updates` is `price`/
// `quantity`/`promotion_code`, scoped to the subscription as a whole). So
// Portal here handles payment method, invoice history, cancellation, and
// switching between whole base plans; addAddonItem/removeAddonItem below are
// this codebase's own small API for the 'custom' plan's à-la-carte addons,
// calling Stripe's Subscription Items API directly.

const plansSvc = require("../lib/plans");

function dbErr(msg) {
  return Object.assign(new Error(`DB error ${msg}`), { code: "DATABASE_ERROR", statusCode: 500 });
}

async function saveClinicColumns(supabaseClient, clinicId, patch) {
  const { data, error } = await supabaseClient
    .from("Clinic")
    .update({ ...patch, updatedAt: new Date().toISOString() })
    .eq("id", clinicId)
    .select()
    .maybeSingle();
  if (error) throw dbErr(`updating clinic subscription fields: ${error.message}`);
  if (!data) throw Object.assign(new Error(`Clinic '${clinicId}' not found`), { code: "CLINIC_NOT_FOUND", statusCode: 404 });
  return data;
}

// Creates (and persists) a Stripe Customer for a clinic that doesn't have one
// yet; returns the existing id unchanged otherwise. Idempotent to call.
async function getOrCreateCustomer(stripeClient, supabaseClient, clinic) {
  if (clinic.stripeCustomerId) return clinic.stripeCustomerId;

  const customer = await stripeClient.customers.create({
    name: clinic.name ?? undefined,
    email: clinic.email ?? undefined,
    metadata: { clinicId: clinic.id },
  });
  await saveClinicColumns(supabaseClient, clinic.id, { stripeCustomerId: customer.id });
  return customer.id;
}

// mode:"subscription" Checkout Session for a clinic's initial plan purchase
// (or a full plan re-purchase) — one line item per Price (base + any
// 'custom'-plan addons selected up front). Throws STRIPE_PRICE_NOT_CONFIGURED
// (via the caller's missingStripePriceIds check) before this is ever called
// with an unset price id.
function createSubscriptionCheckoutSession(stripeClient, { customerId, clinicId, planId, addonIds = [], successUrl, cancelUrl }) {
  const lineItems = [{ price: plansSvc.stripePriceIdFor(planId), quantity: 1 }];
  if (planId === "custom") {
    addonIds.forEach((addonId) => lineItems.push({ price: plansSvc.stripePriceIdFor(addonId), quantity: 1 }));
  }

  return stripeClient.checkout.sessions.create({
    mode: "subscription",
    customer: customerId,
    line_items: lineItems,
    metadata: { clinicId, planId, addonIds: JSON.stringify(addonIds) },
    subscription_data: { metadata: { clinicId, planId, addonIds: JSON.stringify(addonIds) } },
    success_url: successUrl,
    cancel_url: cancelUrl,
  });
}

function createPortalSession(stripeClient, { customerId, returnUrl, configurationId }) {
  return stripeClient.billingPortal.sessions.create({
    customer: customerId,
    return_url: returnUrl,
    ...(configurationId ? { configuration: configurationId } : {}),
  });
}

// Adds one 'custom'-plan addon as a new subscription item — Portal can't
// express this (see file header), so this calls Stripe directly.
async function addAddonItem(stripeClient, supabaseClient, clinic, addonId) {
  if (!clinic.stripeSubscriptionId) {
    throw Object.assign(new Error("Clinic has no active subscription to add an addon to"), {
      code: "NO_SUBSCRIPTION",
      statusCode: 409,
    });
  }
  const priceId = plansSvc.stripePriceIdFor(addonId);
  if (!priceId) {
    throw Object.assign(new Error(`No Stripe Price configured for addon '${addonId}'`), {
      code: "STRIPE_PRICE_NOT_CONFIGURED",
      statusCode: 503,
    });
  }
  const existingItems = clinic.subscriptionItems ?? {};
  if (existingItems.addons?.[addonId]) {
    return existingItems; // already added — idempotent no-op
  }

  const item = await stripeClient.subscriptionItems.create({
    subscription: clinic.stripeSubscriptionId,
    price: priceId,
  });

  const subscriptionItems = {
    ...existingItems,
    addons: { ...(existingItems.addons ?? {}), [addonId]: { itemId: item.id, priceId } },
  };
  await saveClinicColumns(supabaseClient, clinic.id, { subscriptionItems });
  return subscriptionItems;
}

// Removes one 'custom'-plan addon's subscription item. No-ops (doesn't
// throw) if the addon was never added — matches this codebase's other
// webhook-adjacent "defensive, idempotent" write patterns.
async function removeAddonItem(stripeClient, supabaseClient, clinic, addonId) {
  const existingItems = clinic.subscriptionItems ?? {};
  const addonItem = existingItems.addons?.[addonId];
  if (!addonItem) return existingItems;

  await stripeClient.subscriptionItems.del(addonItem.itemId);

  const remainingAddons = { ...existingItems.addons };
  delete remainingAddons[addonId];
  const subscriptionItems = { ...existingItems, addons: remainingAddons };
  await saveClinicColumns(supabaseClient, clinic.id, { subscriptionItems });
  return subscriptionItems;
}

// Syncs a Stripe Subscription object (from a checkout completion or any
// customer.subscription.* webhook) back onto the Clinic row: status, current
// period end, the item-id map addAddonItem/removeAddonItem rely on, and —
// only on the very first sync, when subscriptionItems.base isn't set yet —
// the human-readable Clinic.plan intent blob, so `entitlementsForPlan` stays
// correct after a Checkout-driven purchase without a second manual step.
async function syncSubscriptionFromStripeObject(supabaseClient, clinicId, subscription) {
  const items = subscription.items?.data ?? [];
  const baseItem = items[0] ?? null;
  const currentPeriodEnd = baseItem?.current_period_end ?? subscription.current_period_end ?? null;

  const patch = {
    stripeSubscriptionId: subscription.id,
    subscriptionStatus: subscription.status,
    subscriptionCurrentPeriodEnd: currentPeriodEnd ? new Date(currentPeriodEnd * 1000).toISOString() : null,
  };

  // Only (re)establish which item is "the base" the first time this
  // subscription is seen — later webhook syncs must not clobber addon items
  // that addAddonItem/removeAddonItem have since tracked independently.
  const { data: existingClinic } = await supabaseClient.from("Clinic").select("subscriptionItems, plan").eq("id", clinicId).maybeSingle();
  if (!existingClinic?.subscriptionItems?.base && baseItem) {
    const planId = subscription.metadata?.planId ?? existingClinic?.plan?.planId ?? "basic";
    let addonIds = [];
    try {
      addonIds = JSON.parse(subscription.metadata?.addonIds ?? "[]");
    } catch {
      addonIds = [];
    }
    patch.subscriptionItems = {
      base: { itemId: baseItem.id, priceId: baseItem.price?.id ?? null, planId },
      addons: {},
    };
    patch.plan = {
      planId,
      addonIds: planId === "custom" ? addonIds : [],
      priceConfigVersion: plansSvc.PRICE_CONFIG_VERSION,
      billingPeriod: "monthly",
      estimatedMonthlyPaise: plansSvc.estimateMonthlyPaise(planId, addonIds),
    };
  }

  return saveClinicColumns(supabaseClient, clinicId, patch);
}

// Human-readable summary for GET /billing/subscription.
function subscriptionSummary(clinic) {
  return {
    plan: clinic.plan ?? null,
    stripeSubscriptionId: clinic.stripeSubscriptionId ?? null,
    subscriptionStatus: clinic.subscriptionStatus ?? null,
    subscriptionCurrentPeriodEnd: clinic.subscriptionCurrentPeriodEnd ?? null,
    addons: Object.keys(clinic.subscriptionItems?.addons ?? {}),
    hasStripeCustomer: Boolean(clinic.stripeCustomerId),
  };
}

module.exports = {
  getOrCreateCustomer,
  createSubscriptionCheckoutSession,
  createPortalSession,
  addAddonItem,
  removeAddonItem,
  syncSubscriptionFromStripeObject,
  subscriptionSummary,
};
