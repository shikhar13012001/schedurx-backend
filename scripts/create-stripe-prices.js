// One-off setup script (matches this repo's scripts/setup-*.js convention):
// creates the 11 real Stripe Products/Prices Phase 2's subscription billing
// needs (STRIPE_PRICE_BASIC, STRIPE_PRICE_PREMIUM, STRIPE_PRICE_CUSTOM_BASE,
// STRIPE_PRICE_ADDON_*) and prints them as ready-to-paste .env lines.
//
// Idempotent-ish: re-running creates duplicate Products (Stripe has no
// natural unique key to check against here) — run once, or archive the old
// ones in the Dashboard first if re-running deliberately.
//
// Usage: STRIPE_SECRET_KEY=sk_test_... node scripts/create-stripe-prices.js
// Refuses to run against a live-mode key (sk_live_...) — this only ever
// creates test-mode catalog data.

require("dotenv").config();
const Stripe = require("stripe");

const secretKey = process.env.STRIPE_SECRET_KEY;
if (!secretKey) {
  console.error("STRIPE_SECRET_KEY is not set.");
  process.exit(1);
}
if (!secretKey.startsWith("sk_test_")) {
  console.error("Refusing to run: STRIPE_SECRET_KEY is not a test-mode key (must start with sk_test_).");
  process.exit(1);
}

const stripe = new Stripe(secretKey);

// name, envVar, unitAmountPaise (INR paise = smallest unit)
const CATALOG = [
  { name: "ScheduRx — Clinic Core (Basic)", envVar: "STRIPE_PRICE_BASIC", amount: 99900 },
  { name: "ScheduRx — Clinic Autopilot (Premium)", envVar: "STRIPE_PRICE_PREMIUM", amount: 449900 },
  { name: "ScheduRx — Build Your Own (Custom base)", envVar: "STRIPE_PRICE_CUSTOM_BASE", amount: 99900 },
  { name: "ScheduRx Add-on — Online Consultations", envVar: "STRIPE_PRICE_ADDON_ONLINE_CONSULTATIONS", amount: 34900 },
  { name: "ScheduRx Add-on — Smart IVR", envVar: "STRIPE_PRICE_ADDON_SMART_IVR", amount: 49900 },
  { name: "ScheduRx Add-on — AI Calling Agent", envVar: "STRIPE_PRICE_ADDON_AI_CALLING_AGENT", amount: 59900 },
  { name: "ScheduRx Add-on — AI WhatsApp Agent", envVar: "STRIPE_PRICE_ADDON_AI_WHATSAPP_AGENT", amount: 69900 },
  { name: "ScheduRx Add-on — Recorded Call Reminders", envVar: "STRIPE_PRICE_ADDON_RECORDED_CALL_REMINDERS", amount: 29900 },
  { name: "ScheduRx Add-on — AI Follow-up Agent", envVar: "STRIPE_PRICE_ADDON_AI_FOLLOWUP_AGENT", amount: 39900 },
  { name: "ScheduRx Add-on — Ambient Clinical Listening", envVar: "STRIPE_PRICE_ADDON_AMBIENT_LISTENING", amount: 149900 },
  { name: "ScheduRx Add-on — Premium Website", envVar: "STRIPE_PRICE_ADDON_PREMIUM_WEBSITE", amount: 39900 },
];

async function main() {
  console.log(`[stripe-setup] creating ${CATALOG.length} products/prices in TEST mode...\n`);
  const envLines = [];

  for (const item of CATALOG) {
    const product = await stripe.products.create({ name: item.name });
    const price = await stripe.prices.create({
      product: product.id,
      currency: "inr",
      unit_amount: item.amount,
      recurring: { interval: "month" },
    });
    console.log(`${item.envVar} = ${price.id}  (${item.name}, ₹${item.amount / 100}/mo)`);
    envLines.push(`${item.envVar}=${price.id}`);
  }

  console.log("\n--- paste into .env ---\n");
  console.log(envLines.join("\n"));
}

main().catch((err) => {
  console.error("[stripe-setup] failed:", err.message);
  process.exit(1);
});
