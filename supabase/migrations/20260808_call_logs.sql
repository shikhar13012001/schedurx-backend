-- Voice-agent call history, staff-facing. No caller populates this table yet
-- (schedurx-calling-agent has zero Supabase footprint today — see docs) but
-- the read API and schema are real from day one, same pattern as Thread/WaLog.

CREATE TABLE IF NOT EXISTS "CallLog" (
  id            text PRIMARY KEY,
  "clinicId"    text NOT NULL REFERENCES "Clinic"(id),
  "patientId"   text REFERENCES "Patient"(id),
  phone         text NOT NULL,
  name          text,
  lang          text,
  "durationSec" integer NOT NULL DEFAULT 0,
  outcome       text NOT NULL DEFAULT 'info',
  summary       text,
  "recordingUrl" text,
  "createdAt"   timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE IF EXISTS "CallLog"
  DROP CONSTRAINT IF EXISTS call_log_outcome_is_valid;

ALTER TABLE IF EXISTS "CallLog"
  ADD CONSTRAINT call_log_outcome_is_valid
    CHECK (outcome IN ('booked', 'rescheduled', 'reminder_confirmed', 'recovered_missed', 'info'));

CREATE INDEX IF NOT EXISTS call_log_clinic_idx ON "CallLog" ("clinicId", "createdAt" DESC);
