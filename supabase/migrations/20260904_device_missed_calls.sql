-- Android missed-call safety net (mobile-shell APK). A second missed-call
-- detection path alongside the existing Twilio carrier-forwarding one
-- (20260808_call_logs.sql, 20260818_twilio_comms.sql) — a staff member's
-- phone reports a missed call directly from its native call log via
-- POST /api/v1/device-calls, instead of relying on carrier forwarding ever
-- being configured correctly. See webhooks-twilio.js / missed-call-service.js.
--
-- No CLI migration runner in this repo — apply via `psql` or the Supabase SQL
-- Editor, per README.md's "Database migrations" section.

ALTER TABLE "CallLog" ADD COLUMN IF NOT EXISTS "source" text NOT NULL DEFAULT 'twilio_ivr';
ALTER TABLE "CallLog" ADD COLUMN IF NOT EXISTS "staffId" text REFERENCES "Staff"(id);
ALTER TABLE "CallLog" ADD COLUMN IF NOT EXISTS "deviceCallTimestamp" bigint;

ALTER TABLE IF EXISTS "CallLog"
  DROP CONSTRAINT IF EXISTS call_log_source_is_valid;
ALTER TABLE IF EXISTS "CallLog"
  ADD CONSTRAINT call_log_source_is_valid
    CHECK ("source" IN ('twilio_ivr', 'android_native'));

-- Idempotency for a WorkManager retry or a receiver double-fire reporting the
-- same on-device call twice — deviceCallTimestamp is the device's own
-- CallLog.Calls.DATE (epoch ms), stable across retries of the same call.
CREATE UNIQUE INDEX IF NOT EXISTS call_log_device_dedup_idx
  ON "CallLog" ("clinicId", "phone", "deviceCallTimestamp")
  WHERE "deviceCallTimestamp" IS NOT NULL;

-- Clinic-scoped policy ("always log calls from this known number even though
-- it's a saved contact"), not a personal per-staff preference — any staff
-- member's app honors the same list. Uniqueness is per normalized phone, per
-- clinic.
CREATE TABLE IF NOT EXISTS "CallerWhitelist" (
  id                text PRIMARY KEY,
  "clinicId"        text NOT NULL REFERENCES "Clinic"(id),
  phone             text NOT NULL,
  label             text,
  "addedByStaffId"  text REFERENCES "Staff"(id),
  "createdAt"       timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS caller_whitelist_clinic_phone_idx ON "CallerWhitelist" ("clinicId", phone);
