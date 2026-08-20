// Stripe webhook — must see the untouched request body for signature
// verification, so this router applies its own express.raw() parser and must
// be mounted in app.js BEFORE app.use(express.json()) runs on the request.
// Only mounted at all when stripeClient is configured (see app.js).

const { Router, raw } = require("express");
const stripeSvc = require("../services/stripe-service");
const invoiceSvc = require("../services/invoice-service");
const { config } = require("../config");

function createStripeWebhookRouter(supabaseClient, stripeClient) {
  const router = Router();

  router.post("/", raw({ type: "application/json" }), async (req, res) => {
    const signature = req.headers["stripe-signature"];
    let event;
    try {
      event = stripeSvc.constructEvent(stripeClient, req.body, signature, config.STRIPE_WEBHOOK_SECRET);
    } catch (err) {
      req.log?.warn({ err }, "[stripe-webhook] signature verification failed");
      return res.status(400).json({ error: `Webhook signature verification failed: ${err.message}` });
    }

    if (event.type === "checkout.session.completed") {
      const session = event.data.object;
      try {
        await invoiceSvc.markPaidByStripeSession(supabaseClient, session.id, session.payment_intent);
      } catch (err) {
        req.log?.error({ err, sessionId: session.id }, "[stripe-webhook] failed to mark invoice paid");
        // Still 200 — Stripe retries on non-2xx, and retrying won't fix a DB error;
        // this is logged for manual reconciliation instead.
      }
    }

    return res.status(200).json({ received: true });
  });

  return router;
}

module.exports = { createStripeWebhookRouter };
