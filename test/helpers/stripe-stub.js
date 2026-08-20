// Shaped like a Stripe client — just the .webhooks.constructEvent() and
// .checkout.sessions.create() surface this project's code actually calls.
function createStripeStub({ event = null, shouldRejectSignature = false, session = null } = {}) {
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
  };
}

module.exports = { createStripeStub };
