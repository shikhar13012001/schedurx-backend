-- Twilio Voice/SMS/WhatsApp missed-call automation. See phone-route-service.js,
-- webhooks-twilio.js, call-log-service.js's upsertByTwilioCallSid.
--
-- No CLI migration runner in this repo — apply via `psql` or the Supabase SQL
-- Editor, per README.md's "Database migrations" section.

-- Many-valued original-number → clinic/doctor mapping. Supersedes the strict
-- 1:1 assumption baked into phone-clinic-store.js / internal-call-context.js
-- (Clinic.phone exact match) for the Twilio call-forwarding path specifically
-- — that existing resolver is untouched and still used by the Ultravox flow.
CREATE TABLE IF NOT EXISTS "PhoneNumberRoute" (
  id text PRIMARY KEY,
  "clinicId" text NOT NULL REFERENCES "Clinic"(id),
  "doctorId" text REFERENCES "Doctor"(id),
  "originalNumber" text NOT NULL,
  "twilioNumber" text,
  "isActive" boolean NOT NULL DEFAULT true,
  "createdAt" timestamptz NOT NULL DEFAULT now(),
  "updatedAt" timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS phone_number_route_original_idx ON "PhoneNumberRoute" ("originalNumber");
CREATE INDEX IF NOT EXISTS phone_number_route_clinic_idx ON "PhoneNumberRoute" ("clinicId");

-- Idempotent dedup for redelivered Twilio voice webhooks — upsertByTwilioCallSid
-- looks this up before deciding insert vs update.
ALTER TABLE "CallLog" ADD COLUMN IF NOT EXISTS "twilioCallSid" text;
CREATE UNIQUE INDEX IF NOT EXISTS call_log_twilio_call_sid_idx ON "CallLog" ("twilioCallSid") WHERE "twilioCallSid" IS NOT NULL;

-- Dedup for the (slice 2) appointment-lifecycle reminder/follow-up workflows —
-- one row per scheduled communication instance, keyed so a redelivered nettu
-- reminder webhook can't send the same message twice. "Reminder" itself
-- predates this repo's migrations (see docs/live-schema-baseline.md) — this
-- only adds the dedup index, not the table.
CREATE UNIQUE INDEX IF NOT EXISTS reminder_appointment_type_idx ON "Reminder" ("appointmentId", "type");
