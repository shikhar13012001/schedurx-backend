// Stripe webhook — must see the untouched request body for signature
// verification, so this router applies its own express.raw() parser and must
// be mounted in app.js BEFORE app.use(express.json()) runs on the request.
// Only mounted at all when stripeClient is configured (see app.js).

const { Router, raw } = require("express");
const stripeSvc = require("../services/stripe-service");
const invoiceSvc = require("../services/invoice-service");
const stripeSubSvc = require("../services/stripe-subscription-service");
const notificationSvc = require("../services/notification-service");
const appointmentSvc = require("../services/appointment-service");
const { config } = require("../config");

// Both checkout.session.completed (one-off Invoice payment) and
// customer.subscription.created/updated (subscription checkout completion,
// or any later Portal/Dashboard-driven change) can name the clinic — a
// subscription's own metadata is set at Checkout time by
// stripe-subscription-service.js's createSubscriptionCheckoutSession, so
// this is preferred; falling back to a stripeCustomerId lookup covers
// changes Stripe itself initiates (e.g. a Portal edit) where metadata may
// not carry clinicId.
async function resolveClinicIdForSubscription(supabaseClient, subscription) {
  if (subscription.metadata?.clinicId) return subscription.metadata.clinicId;
  const { data } = await supabaseClient
    .from("Clinic")
    .select("id")
    .eq("stripeCustomerId", subscription.customer)
    .maybeSingle();
  return data?.id ?? null;
}

function createStripeWebhookRouter(supabaseClient, stripeClient, twilioClient) {
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
      if (session.metadata?.pendingBookingId) {
        // Pay-first token booking (Phase 3) — turns the held slot into a
        // real Appointment. Idempotent on the PendingBooking's own status,
        // so a Stripe retry of this same event is safe.
        try {
          await appointmentSvc.finalizePendingBooking(supabaseClient, session.metadata.pendingBookingId, req.log, twilioClient);
        } catch (err) {
          req.log?.error(
            { err, pendingBookingId: session.metadata.pendingBookingId },
            "[stripe-webhook] failed to finalize pending token booking",
          );
          // Still 200 — same reconciliation-over-retry reasoning as the branches below.
        }
      } else if (session.mode !== "subscription") {
        // mode:"subscription" sessions have no matching Invoice row (only
        // mode:"payment" ones do — see stripe-service.js's createCheckoutSession
        // vs. stripe-subscription-service.js's createSubscriptionCheckoutSession)
        // — markPaidByStripeSession no-ops harmlessly for those, but skipping
        // the call entirely avoids a pointless write attempt.
        try {
          await invoiceSvc.markPaidByStripeSession(supabaseClient, session.id, session.payment_intent);
        } catch (err) {
          req.log?.error({ err, sessionId: session.id }, "[stripe-webhook] failed to mark invoice paid");
          // Still 200 — Stripe retries on non-2xx, and retrying won't fix a DB error;
          // this is logged for manual reconciliation instead.
        }
      }
    }

    if (
      event.type === "customer.subscription.created" ||
      event.type === "customer.subscription.updated" ||
      event.type === "customer.subscription.deleted"
    ) {
      const subscription = event.data.object;
      try {
        const clinicId = await resolveClinicIdForSubscription(supabaseClient, subscription);
        if (!clinicId) {
          req.log?.warn({ subscriptionId: subscription.id }, "[stripe-webhook] subscription event for unknown clinic");
        } else {
          await stripeSubSvc.syncSubscriptionFromStripeObject(supabaseClient, clinicId, subscription);
        }
      } catch (err) {
        req.log?.error({ err, subscriptionId: subscription.id }, "[stripe-webhook] failed to sync subscription");
        // Still 200 — same reconciliation-over-retry reasoning as above.
      }
    }

    if (event.type === "invoice.payment_failed") {
      const invoice = event.data.object;
      try {
        const { data: clinic } = await supabaseClient
          .from("Clinic")
          .select("id")
          .eq("stripeCustomerId", invoice.customer)
          .maybeSingle();
        if (clinic) {
          await notificationSvc.createNotification(supabaseClient, {
            clinicId: clinic.id,
            staffId: null, // clinic-wide broadcast — every owner/staff should see a failed subscription payment
            type: "billing_payment_failed",
            title: "Subscription payment failed",
            body: "ScheduRx couldn't charge your card for this billing period. Update your payment method to avoid losing access.",
            data: { stripeInvoiceId: invoice.id },
          });
        }
      } catch (err) {
        req.log?.error({ err, invoiceId: invoice.id }, "[stripe-webhook] failed to notify of payment failure");
      }
    }

    return res.status(200).json({ received: true });
  });

  return router;
}

module.exports = { createStripeWebhookRouter };
