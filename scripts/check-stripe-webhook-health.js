// Catches exactly tonight's incident automatically: the Stripe webhook
// endpoint pointed at a URL that got firewalled shut, and nobody knew until
// a real patient's payment silently never turned into a booking. Checks two
// things Stripe's API already exposes, cheaply, with no new infrastructure:
//   1. Is our webhook endpoint actually "enabled"? Stripe auto-disables an
//      endpoint after enough consecutive delivery failures — that alone
//      would have caught this eventually, just not soon enough.
//   2. Do recent events for the types we actually handle still have
//      pending_webhooks > 0 a few minutes after being created? A healthy
//      endpoint acknowledges within seconds; anything still pending after
//      PENDING_THRESHOLD_MINUTES means deliveries are failing right now.
//
// Exit code 0 = healthy, 1 = unhealthy — meant to be run on a schedule (see
// the systemd timer this ships alongside) so a stuck webhook shows up in
// journalctl within minutes instead of silently sitting broken.
//
// Usage: node scripts/check-stripe-webhook-health.js

require("dotenv").config();
const Stripe = require("stripe");

const PENDING_THRESHOLD_MINUTES = 5;
const EVENT_TYPES_TO_CHECK = [
  "checkout.session.completed",
  "customer.subscription.created",
  "customer.subscription.updated",
  "customer.subscription.deleted",
  "invoice.payment_failed",
];

if (!process.env.STRIPE_SECRET_KEY) {
  console.log("[webhook-health] STRIPE_SECRET_KEY not configured — nothing to check, exiting healthy.");
  process.exit(0);
}

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

async function main() {
  let healthy = true;

  // 1. Endpoint status — expects exactly one endpoint pointed at our own
  // domain (not third-party integrations sharing this Stripe account).
  const endpoints = await stripe.webhookEndpoints.list({ limit: 20 });
  const ours = endpoints.data.filter((e) => e.url.includes("schedurx.com"));
  if (ours.length === 0) {
    console.error("[webhook-health] UNHEALTHY — no webhook endpoint configured for a schedurx.com URL at all.");
    healthy = false;
  }
  for (const endpoint of ours) {
    if (endpoint.status !== "enabled") {
      console.error(`[webhook-health] UNHEALTHY — endpoint ${endpoint.id} (${endpoint.url}) status is '${endpoint.status}', not 'enabled'.`);
      healthy = false;
    } else {
      console.log(`[webhook-health] OK — endpoint ${endpoint.id} (${endpoint.url}) is enabled.`);
    }
  }

  // 2. Recent events actually reaching us.
  const cutoffMs = Date.now() - PENDING_THRESHOLD_MINUTES * 60_000;
  for (const type of EVENT_TYPES_TO_CHECK) {
    const events = await stripe.events.list({ type, limit: 10 });
    const stuck = events.data.filter((e) => e.pending_webhooks > 0 && e.created * 1000 < cutoffMs);
    for (const event of stuck) {
      console.error(
        `[webhook-health] UNHEALTHY — ${event.id} (${type}, created ${new Date(event.created * 1000).toISOString()}) ` +
          `still has pending_webhooks=${event.pending_webhooks} after ${PENDING_THRESHOLD_MINUTES}+ minutes.`,
      );
      healthy = false;
    }
  }

  if (healthy) {
    console.log("[webhook-health] All checks passed.");
  }
  process.exit(healthy ? 0 : 1);
}

main().catch((err) => {
  console.error("[webhook-health] check itself crashed:", err);
  process.exit(1);
});
