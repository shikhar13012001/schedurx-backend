// Shaped like a Stripe client — just the surface this project's code
// actually calls: .webhooks.constructEvent(), .checkout.sessions.create(),
// and (Phase 2) .customers.create(), .billingPortal.sessions.create(),
// .subscriptionItems.create()/.del().
function createStripeStub({
  event = null,
  shouldRejectSignature = false,
  session = null,
  customer = null,
  portalSession = null,
  subscriptionItem = null,
} = {}) {
  const deletedItemIds = [];
  return {
    webhooks: {
      constructEvent(rawBody, signature, secret) {
        if (shouldRejectSignature) throw new Error("invalid signature");
        return event;
      },
    },
    checkout: {
      sessions: {
        async create() {
          return session ?? { id: "cs_test_123", url: "https://checkout.stripe.com/test" };
        },
      },
    },
    customers: {
      async create() {
        return customer ?? { id: "cus_test_123" };
      },
    },
    billingPortal: {
      sessions: {
        async create() {
          return portalSession ?? { id: "bps_test_123", url: "https://billing.stripe.com/test" };
        },
      },
    },
    subscriptionItems: {
      async create() {
        return subscriptionItem ?? { id: "si_test_123" };
      },
      async del(itemId) {
        deletedItemIds.push(itemId);
        return { id: itemId, deleted: true };
      },
    },
    _deletedItemIds: deletedItemIds,
  };
}

module.exports = { createStripeStub };
