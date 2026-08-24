// Live smoke test for Phase 2's subscription billing — never exercised
// end-to-end with real Stripe Price IDs before now (those were only just
// created by scripts/create-stripe-prices.js). Runs the FULL real loop
// against the deployed backend, not a mock:
//
//   1. spins up a throwaway "[E2E] Billing Smoke Test Clinic" (same
//      self-cleaning pattern as scripts/eval-whatsapp-agent.js)
//   2. mints a real Firebase ID token for its owner (custom token ->
//      Identity Toolkit exchange, so this is a genuine Bearer-token request,
//      not a bypass)
//   3. POSTs /api/v1/billing/subscription/checkout-session with planId
//      "basic" -> confirms Stripe accepts the real Price ID and a Customer
//      gets created and persisted onto the Clinic row
//   4. creates a real (test-mode) Stripe Subscription on that customer using
//      Stripe's special test PaymentMethod token (pm_card_visa — valid only
//      in test mode, no real card data involved), so this genuinely charges
//      and activates a subscription the same way a real checkout completion
//      would
//   5. fetches the REAL event Stripe generated for that subscription
//      (customer.subscription.created) via the Events API, re-signs it with
//      the real STRIPE_WEBHOOK_SECRET (stripe.webhooks.generateTestHeaderString),
//      and POSTs it to /webhooks/stripe — this exercises the actual
//      signature-verification + sync code path, not a stub
//   6. confirms GET /api/v1/billing/subscription now reflects the synced
//      status
//   7. exercises POST /api/v1/billing/subscription/portal-session
//   8. tears everything down: cancels the Stripe subscription, deletes the
//      Stripe customer, deletes the E2E clinic + throwaway Firebase user
//
// Usage:
//   EVAL_BASE_URL=http://localhost:4000 node scripts/smoke-test-stripe-subscription.js
//   (defaults to the droplet if unset, same convention as the WhatsApp eval)
//
// Refuses to run against a non-test-mode Stripe key — this creates and
// charges a real (test) subscription, never point it at live-mode keys.

require("dotenv").config();
const crypto = require("node:crypto");
const Stripe = require("stripe");

const BASE_URL = process.env.EVAL_BASE_URL || "http://139.59.34.211:4000";
const INTERNAL_API_KEY = process.env.INTERNAL_API_KEY;
const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY;
const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET;
const FIREBASE_WEB_API_KEY = process.env.FIREBASE_WEB_API_KEY || process.env.NEXT_PUBLIC_FIREBASE_API_KEY;
const TEST_CLINIC_NAME = "[E2E] Billing Smoke Test Clinic";

if (!INTERNAL_API_KEY || !STRIPE_SECRET_KEY || !STRIPE_WEBHOOK_SECRET) {
  console.error("Missing INTERNAL_API_KEY / STRIPE_SECRET_KEY / STRIPE_WEBHOOK_SECRET in .env — cannot run.");
  process.exit(1);
}
if (!STRIPE_SECRET_KEY.startsWith("sk_test_")) {
  console.error("STRIPE_SECRET_KEY is not a test-mode key (sk_test_...) — refusing to run against live Stripe.");
  process.exit(1);
}
if (!FIREBASE_WEB_API_KEY) {
  console.error(
    "Missing FIREBASE_WEB_API_KEY / NEXT_PUBLIC_FIREBASE_API_KEY in .env — needed to exchange a Firebase custom " +
      "token for a real ID token (Identity Toolkit's signInWithCustomToken).",
  );
  process.exit(1);
}

const stripe = new Stripe(STRIPE_SECRET_KEY);

let failed = false;
function check(label, cond, detail) {
  if (cond) {
    console.log(`PASS  ${label}`);
  } else {
    failed = true;
    console.log(`FAIL  ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

async function internalRequest(method, path, body) {
  const response = await fetch(`${BASE_URL}${path}`, {
    method,
    headers: { Authorization: `Bearer ${INTERNAL_API_KEY}`, "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await response.json().catch(() => null);
  return { status: response.status, body: json };
}

async function ownerRequest(method, path, idToken, body) {
  const response = await fetch(`${BASE_URL}${path}`, {
    method,
    headers: { Authorization: `Bearer ${idToken}`, "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await response.json().catch(() => null);
  return { status: response.status, body: json };
}

function buildFirebaseAdminAuth() {
  const privateKey = process.env.FIREBASE_PRIVATE_KEY_BASE64
    ? Buffer.from(process.env.FIREBASE_PRIVATE_KEY_BASE64, "base64").toString("utf8")
    : process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, "\n");
  if (!process.env.FIREBASE_PROJECT_ID || !process.env.FIREBASE_CLIENT_EMAIL || !privateKey) {
    throw new Error("FIREBASE_PROJECT_ID/FIREBASE_CLIENT_EMAIL/FIREBASE_PRIVATE_KEY(_BASE64) must be set to run this.");
  }
  const { cert, initializeApp } = require("firebase-admin/app");
  const { getAuth } = require("firebase-admin/auth");
  const app = initializeApp(
    { credential: cert({ projectId: process.env.FIREBASE_PROJECT_ID, clientEmail: process.env.FIREBASE_CLIENT_EMAIL, privateKey }) },
    `smoke-${Date.now()}`,
  );
  return getAuth(app);
}

// Real Identity Toolkit REST call — the same exchange the browser SDK does
// in src/app/test-auth/page.tsx, just headless. FIREBASE_WEB_API_KEY is a
// public client key by design (safe to use here), not a secret.
async function exchangeCustomTokenForIdToken(customToken) {
  const res = await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:signInWithCustomToken?key=${FIREBASE_WEB_API_KEY}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token: customToken, returnSecureToken: true }),
  });
  const json = await res.json();
  if (!res.ok) throw new Error(`Identity Toolkit exchange failed: ${JSON.stringify(json)}`);
  return json.idToken;
}

async function setupClinic() {
  const firebaseAdminAuth = buildFirebaseAdminAuth();
  const email = `billing-smoke-${crypto.randomUUID()}@schedurx.test`;
  const firebaseUser = await firebaseAdminAuth.createUser({ email, emailVerified: true });
  const firebaseUid = firebaseUser.uid;

  const created = await internalRequest("POST", "/internal/clinic", {
    firebaseUid,
    email,
    phone: "+919999999901",
    fullName: "Dr. Billing Smoke Owner",
    clinicName: TEST_CLINIC_NAME,
    practiceType: "solo",
    founderRole: "doctor",
    timezone: "Asia/Kolkata",
    workingDays: ["Mon", "Tue", "Wed", "Thu", "Fri"],
    openingHour: 9,
    closingHour: 18,
    doctor: { fullName: "Dr. Billing Smoke", specialty: "General Medicine", feeInr: 500 },
  });
  if (created.status !== 200 || !created.body?.success) {
    throw new Error(`Clinic setup failed: ${JSON.stringify(created.body)}`);
  }

  const customToken = await firebaseAdminAuth.createCustomToken(firebaseUid);
  const idToken = await exchangeCustomTokenForIdToken(customToken);

  return { clinicId: created.body.data.clinic.id, firebaseUid, firebaseAdminAuth, idToken };
}

async function teardown({ clinicId, firebaseAdminAuth, firebaseUid, stripeCustomerId, stripeSubscriptionId }) {
  console.log("[smoke] tearing down...");
  if (stripeSubscriptionId) {
    try {
      await stripe.subscriptions.cancel(stripeSubscriptionId);
    } catch (err) {
      console.error("[smoke] failed to cancel test subscription (non-fatal):", err.message);
    }
  }
  if (stripeCustomerId) {
    try {
      await stripe.customers.del(stripeCustomerId);
    } catch (err) {
      console.error("[smoke] failed to delete test Stripe customer (non-fatal):", err.message);
    }
  }
  if (clinicId) await internalRequest("DELETE", `/internal/clinic/${clinicId}`);
  if (firebaseAdminAuth && firebaseUid) {
    try {
      await firebaseAdminAuth.deleteUser(firebaseUid);
    } catch (err) {
      console.error("[smoke] failed to delete throwaway Firebase user (non-fatal):", err.message);
    }
  }
}

async function main() {
  console.log(`[smoke] target: ${BASE_URL}`);
  console.log("[smoke] setting up throwaway clinic...");
  const ctx = await setupClinic();
  let stripeCustomerId = null;
  let stripeSubscriptionId = null;

  try {
    // 1. Subscription checkout session — real Price ID, real Customer creation.
    const checkout = await ownerRequest("POST", "/api/v1/billing/subscription/checkout-session", ctx.idToken, {
      planId: "basic",
      successUrl: "https://example.com/success",
      cancelUrl: "https://example.com/cancel",
    });
    check("checkout-session succeeds with the real STRIPE_PRICE_BASIC", checkout.status === 200 && checkout.body?.success, JSON.stringify(checkout.body));
    check(
      "checkout-session returns a real Stripe-hosted URL",
      typeof checkout.body?.data?.checkoutUrl === "string" && checkout.body.data.checkoutUrl.startsWith("https://checkout.stripe.com/"),
      checkout.body?.data?.checkoutUrl,
    );

    const summaryAfterCheckout = await ownerRequest("GET", "/api/v1/billing/subscription", ctx.idToken);
    check("a Stripe Customer was created and persisted on the Clinic row", summaryAfterCheckout.body?.data?.hasStripeCustomer === true, JSON.stringify(summaryAfterCheckout.body));

    // Need the raw customer id for the next steps — checkout-session's
    // response deliberately doesn't leak it (frontend never needs it), so
    // read it straight off the just-created Stripe Checkout Session instead.
    const session = await stripe.checkout.sessions.retrieve(checkout.body.data.sessionId);
    stripeCustomerId = typeof session.customer === "string" ? session.customer : session.customer?.id;
    check("resolved the real Stripe customer id from the Checkout Session", Boolean(stripeCustomerId));

    // 2. Actually activate a subscription — Stripe's special test-mode
    // PaymentMethod token (valid only with test-mode keys, no real card
    // data), attached + set default, then a real Subscription created
    // directly (mirrors what a completed Checkout would have produced).
    await stripe.paymentMethods.attach("pm_card_visa", { customer: stripeCustomerId });
    await stripe.customers.update(stripeCustomerId, { invoice_settings: { default_payment_method: "pm_card_visa" } });
    const subscription = await stripe.subscriptions.create({
      customer: stripeCustomerId,
      items: [{ price: process.env.STRIPE_PRICE_BASIC }],
      metadata: { clinicId: ctx.clinicId, planId: "basic", addonIds: "[]" },
    });
    stripeSubscriptionId = subscription.id;
    check("real test-mode Subscription activates immediately", subscription.status === "active", subscription.status);

    // 3. Pull the REAL event Stripe generated for this subscription and
    // replay it at our webhook, re-signed with the real webhook secret —
    // exercises actual signature verification + sync logic, not a stub.
    let event = null;
    for (let attempt = 0; attempt < 10 && !event; attempt++) {
      const events = await stripe.events.list({ type: "customer.subscription.created", limit: 20 });
      event = events.data.find((e) => e.data.object.id === subscription.id) ?? null;
      if (!event) await new Promise((r) => setTimeout(r, 1000));
    }
    check("Stripe generated a real customer.subscription.created event for it", Boolean(event));

    if (event) {
      const payload = JSON.stringify(event);
      const header = stripe.webhooks.generateTestHeaderString({ payload, secret: STRIPE_WEBHOOK_SECRET });
      const webhookRes = await fetch(`${BASE_URL}/webhooks/stripe`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "Stripe-Signature": header },
        body: payload,
      });
      const webhookBody = await webhookRes.json().catch(() => null);
      check("our webhook accepts the real signed event", webhookRes.status === 200 && webhookBody?.received === true, JSON.stringify(webhookBody));
    }

    // 4. Confirm the sync actually landed on the Clinic row.
    await new Promise((r) => setTimeout(r, 500));
    const summaryAfterSync = await ownerRequest("GET", "/api/v1/billing/subscription", ctx.idToken);
    check("subscription status synced to 'active'", summaryAfterSync.body?.data?.subscriptionStatus === "active", JSON.stringify(summaryAfterSync.body));
    check(
      "stripeSubscriptionId synced",
      summaryAfterSync.body?.data?.stripeSubscriptionId === subscription.id,
      summaryAfterSync.body?.data?.stripeSubscriptionId,
    );
    check("plan.planId synced to 'basic'", summaryAfterSync.body?.data?.plan?.planId === "basic", JSON.stringify(summaryAfterSync.body?.data?.plan));

    // 5. Billing Portal session.
    const portal = await ownerRequest("POST", "/api/v1/billing/subscription/portal-session", ctx.idToken, {
      returnUrl: "https://example.com/billing",
    });
    check(
      "portal-session returns a real Stripe-hosted URL",
      portal.status === 200 && typeof portal.body?.data?.url === "string" && portal.body.data.url.startsWith("https://billing.stripe.com/"),
      JSON.stringify(portal.body),
    );
  } finally {
    await teardown({ clinicId: ctx.clinicId, firebaseAdminAuth: ctx.firebaseAdminAuth, firebaseUid: ctx.firebaseUid, stripeCustomerId, stripeSubscriptionId });
  }

  console.log(failed ? "\n[smoke] FAILED" : "\n[smoke] ALL PASSED");
  process.exit(failed ? 1 : 0);
}

main().catch((err) => {
  console.error("[smoke] crashed:", err);
  process.exit(1);
});
