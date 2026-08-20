#!/usr/bin/env node
// Idempotent Supabase Storage bucket setup for doctor profile photos.
// Public bucket, unlike rx-attachments — these are meant to appear on a
// doctor's public ScheduRx page, so a stable public URL is the point,
// not a short-lived signed one.
//
// Usage: node scripts/setup-doctor-photos-bucket.js
// Required environment variables: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY

require("dotenv").config();

const { createClient } = require("@supabase/supabase-js");

const BUCKET_NAME = "doctor-photos";

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
    fileSizeLimit: "8MB",
    allowedMimeTypes: ["image/jpeg", "image/png", "image/webp"],
  });
  if (createErr) throw new Error(`Creating bucket failed: ${createErr.message}`);

  console.log(`[setup] Bucket '${BUCKET_NAME}' created (public).`);
}

run().catch((err) => {
  console.error("[setup] FATAL:", err.message);
  process.exit(1);
});
