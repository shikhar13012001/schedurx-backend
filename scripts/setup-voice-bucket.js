#!/usr/bin/env node
// Idempotent Supabase Storage bucket setup for cached ElevenLabs greeting
// audio (webhooks-twilio.js's /voice handler). Public bucket — a missed-call
// greeting is just clinic name/phone, nothing sensitive, and a stable public
// URL means Twilio's <Play> can fetch it directly with no signed-URL
// regeneration logic needed.
//
// Usage: npm run setup:voice-bucket
// Required environment variables: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY

require("dotenv").config();

const { createClient } = require("@supabase/supabase-js");

const BUCKET_NAME = "clinic-voice";

function requireEnv(name) {
  const val = process.env[name];
  if (!val) {
    console.error(`[setup] ERROR: environment variable ${name} is required`);
    process.exit(1);
  }
  return val;
}

async function run() {
  const supabaseUrl = requireEnv("SUPABASE_URL");
  const supabaseKey = requireEnv("SUPABASE_SERVICE_ROLE_KEY");
  const supabase = createClient(supabaseUrl, supabaseKey, { auth: { persistSession: false, autoRefreshToken: false } });

  const { data: buckets, error: listErr } = await supabase.storage.listBuckets();
  if (listErr) throw new Error(`Listing buckets failed: ${listErr.message}`);

  if (buckets.some((b) => b.name === BUCKET_NAME)) {
    console.log(`[setup] Bucket '${BUCKET_NAME}' already exists.`);
    return;
  }

  const { error: createErr } = await supabase.storage.createBucket(BUCKET_NAME, {
    public: true,
    fileSizeLimit: "5MB",
    allowedMimeTypes: ["audio/mpeg"],
  });
  if (createErr) throw new Error(`Creating bucket failed: ${createErr.message}`);

  console.log(`[setup] Bucket '${BUCKET_NAME}' created.`);
}

run().catch((err) => {
  console.error("[setup] FATAL:", err.message);
  process.exit(1);
});
