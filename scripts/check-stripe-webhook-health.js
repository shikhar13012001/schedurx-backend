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
// journalctl within minutes instead of silently sitting broken. Also emails
// ALERT_EMAIL_TO when unhealthy (see email-service.js) — logs alone are
// only useful to someone who thinks to go look; this is what actually
// closes the "nobody knew" gap tonight's incident exposed.
//
// Usage: node scripts/check-stripe-webhook-health.js

require("dotenv").config();
const Stripe = require("stripe");
const { createEmailClient } = require("../src/services/email-service");

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
const emailClient = createEmailClient({
  gmailUser: process.env.ALERT_EMAIL_GMAIL_USER,
  gmailAppPassword: process.env.ALERT_EMAIL_GMAIL_APP_PASSWORD,
  alertTo: process.env.ALERT_EMAIL_TO,
});

async function main() {
  const problems = [];

  // 1. Endpoint status — expects exactly one endpoint pointed at our own
  // domain (not third-party integrations sharing this Stripe account).
  const endpoints = await stripe.webhookEndpoints.list({ limit: 20 });
  const ours = endpoints.data.filter((e) => e.url.includes("schedurx.com"));
  if (ours.length === 0) {
    problems.push("No webhook endpoint configured for a schedurx.com URL at all.");
  }
  for (const endpoint of ours) {
    if (endpoint.status !== "enabled") {
      problems.push(`Endpoint ${endpoint.id} (${endpoint.url}) status is '${endpoint.status}', not 'enabled'.`);
    } else {
      console.log(`[webhook-health] OK — endpoint ${endpoint.id} (${endpoint.url}) is enabled.`);
    }
  }

  // 2. Recent events actually reaching us. Bounded to the last hour (well
  // past PENDING_THRESHOLD_MINUTES) — without a `created` filter,
  // events.list's "last 10 of this type" can mean literally the last 10
  // ever for a rare event type like customer.subscription.*, so a handful
  // of stale test-mode events from days ago would flag UNHEALTHY on every
  // single run forever, since nothing new ever pushes them out of the
  // window. A health check nobody can trust because it never stops
  // complaining is worse than no health check.
  const cutoffMs = Date.now() - PENDING_THRESHOLD_MINUTES * 60_000;
  const lookbackSec = Math.floor((Date.now() - 60 * 60_000) / 1000);
  for (const type of EVENT_TYPES_TO_CHECK) {
    const events = await stripe.events.list({ type, created: { gte: lookbackSec }, limit: 10 });
    const stuck = events.data.filter((e) => e.pending_webhooks > 0 && e.created * 1000 < cutoffMs);
    for (const event of stuck) {
      problems.push(
        `${event.id} (${type}, created ${new Date(event.created * 1000).toISOString()}) still has ` +
          `pending_webhooks=${event.pending_webhooks} after ${PENDING_THRESHOLD_MINUTES}+ minutes.`,
      );
    }
  }

  const healthy = problems.length === 0;
  if (healthy) {
    console.log("[webhook-health] All checks passed.");
  } else {
    problems.forEach((p) => console.error(`[webhook-health] UNHEALTHY — ${p}`));
    if (emailClient) {
      try {
        await emailClient.sendAlert({
          subject: "Stripe webhook unhealthy",
          text: `The Stripe webhook health check found ${problems.length} problem(s):\n\n${problems.map((p) => `- ${p}`).join("\n")}\n\nCheck: node scripts/check-stripe-webhook-health.js on the droplet for the current state.`,
        });
        console.log("[webhook-health] Alert email sent.");
      } catch (err) {
        console.error("[webhook-health] Failed to send alert email:", err);
      }
    } else {
      console.log("[webhook-health] ALERT_EMAIL_GMAIL_USER/ALERT_EMAIL_GMAIL_APP_PASSWORD not configured — no alert email sent.");
    }
  }
  process.exit(healthy ? 0 : 1);
}

main().catch((err) => {
  console.error("[webhook-health] check itself crashed:", err);
  process.exit(1);
});
