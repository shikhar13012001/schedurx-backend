#!/usr/bin/env node
// One-time admin setup: registers this backend's reminder-webhook URL with
// the nettu-scheduler account, and prints the verification key nettu will
// echo back on every reminder call. Save that key as NETTU_WEBHOOK_KEY in
// .env — POST /webhooks/nettu-reminders stays unmounted without it.
//
// Safe to re-run — nettu's PUT /api/v1/account/webhook simply overwrites the
// prior registration (and rotates the key) rather than erroring.
//
// Usage:
//   node scripts/setup-nettu-webhook.js https://your-backend.example.com/webhooks/nettu-reminders

require("dotenv").config();
const { NettuClient } = require("../src/services/nettu-client");

async function run() {
  const webhookUrl = process.argv[2];
  if (!webhookUrl) {
    console.error("[setup] Usage: node scripts/setup-nettu-webhook.js <webhook-url>");
    process.exit(1);
  }

  const nettuBaseUrl = process.env.NETTU_BASE_URL;
  const nettuApiKey = process.env.NETTU_API_KEY;
  if (!nettuBaseUrl || !nettuApiKey) {
    console.error("[setup] ERROR: NETTU_BASE_URL and NETTU_API_KEY are required");
    process.exit(1);
  }

  const nettu = new NettuClient({ baseUrl: nettuBaseUrl, apiKey: nettuApiKey });
  const account = await nettu.setAccountWebhook(webhookUrl);

  console.log("[setup] Webhook registered:", account.settings.webhook.url);
  console.log("[setup] Save this in .env as NETTU_WEBHOOK_KEY:");
  console.log(account.settings.webhook.key);
}

run().catch((err) => {
  console.error("[setup] FATAL:", err.message);
  process.exit(1);
});
