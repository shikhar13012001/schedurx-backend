-- Extends the Clinic, Doctor, and Appointment tables with nettu-scheduler integration
-- columns and clinic scheduling-rule fields.
--
-- Column names mirror the camelCase convention already used in this project's
-- Supabase tables (Clinic, Doctor, Patient, Appointment).
-- Run this migration once against your Supabase project:
--   supabase db push   OR   paste into the SQL editor in the Supabase dashboard.

-- ─── Clinic ──────────────────────────────────────────────────────────────────

ALTER TABLE IF EXISTS "Clinic"
  -- Nettu-scheduler IDs (populated by scripts/setup-clinic-calendars.js)
  ADD COLUMN IF NOT EXISTS "schedulerServiceId"  text,
  ADD COLUMN IF NOT EXISTS "schedulerCalendarId" text,

  -- Scheduling configuration
  ADD COLUMN IF NOT EXISTS "timezone"                       text    NOT NULL DEFAULT 'Asia/Kolkata',
  ADD COLUMN IF NOT EXISTS "workingDays"                    jsonb   NOT NULL DEFAULT '["Mon","Tue","Wed","Thu","Fri","Sat"]'::jsonb,
  ADD COLUMN IF NOT EXISTS "openingHour"                    integer NOT NULL DEFAULT 9,
  ADD COLUMN IF NOT EXISTS "closingHour"                    integer NOT NULL DEFAULT 18,
  ADD COLUMN IF NOT EXISTS "defaultAppointmentDurationMins" integer NOT NULL DEFAULT 30,
  ADD COLUMN IF NOT EXISTS "bufferMins"                     integer NOT NULL DEFAULT 5,
  ADD COLUMN IF NOT EXISTS "minNoticeHours"                 integer NOT NULL DEFAULT 2,
  ADD COLUMN IF NOT EXISTS "maxBookingWindowDays"           integer NOT NULL DEFAULT 14,
  ADD COLUMN IF NOT EXISTS "cancellationCutoffHours"        integer NOT NULL DEFAULT 24,
  ADD COLUMN IF NOT EXISTS "rescheduleCutoffHours"          integer NOT NULL DEFAULT 24,

  -- Status
  ADD COLUMN IF NOT EXISTS "status"     text NOT NULL DEFAULT 'active',
  ADD COLUMN IF NOT EXISTS "createdAt"  timestamptz,
  ADD COLUMN IF NOT EXISTS "updatedAt"  timestamptz;

-- Ensure workingDays is always a JSON array
ALTER TABLE IF EXISTS "Clinic"
  DROP CONSTRAINT IF EXISTS clinic_working_days_is_array;

ALTER TABLE IF EXISTS "Clinic"
  ADD CONSTRAINT clinic_working_days_is_array
    CHECK (jsonb_typeof("workingDays") = 'array');

-- ─── Doctor ───────────────────────────────────────────────────────────────────

ALTER TABLE IF EXISTS "Doctor"
  -- Human-readable key used as stable identifier for this doctor's calendar setup
  ADD COLUMN IF NOT EXISTS "doctorCalendarKey"     text UNIQUE,

  -- Nettu-scheduler IDs (populated by scripts/setup-clinic-calendars.js)
  ADD COLUMN IF NOT EXISTS "schedulerDoctorId"     text UNIQUE,
  ADD COLUMN IF NOT EXISTS "schedulerCalendarId"   text UNIQUE,

  -- Doctor-level scheduling overrides (null = inherit from clinic)
  ADD COLUMN IF NOT EXISTS "timezone"              text,
  ADD COLUMN IF NOT EXISTS "workingDaysOverride"   jsonb,
  ADD COLUMN IF NOT EXISTS "workingHoursStart"     text    DEFAULT '09:00',
  ADD COLUMN IF NOT EXISTS "workingHoursEnd"       text    DEFAULT '18:00',
  ADD COLUMN IF NOT EXISTS "unavailableDates"      jsonb   NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS "slotDurationOverrideMins" integer,
  ADD COLUMN IF NOT EXISTS "bufferOverrideMins"    integer,

  ADD COLUMN IF NOT EXISTS "createdAt"             timestamptz,
  ADD COLUMN IF NOT EXISTS "updatedAt"             timestamptz;

ALTER TABLE IF EXISTS "Doctor"
  DROP CONSTRAINT IF EXISTS doctor_unavailable_dates_is_array;

ALTER TABLE IF EXISTS "Doctor"
  ADD CONSTRAINT doctor_unavailable_dates_is_array
    CHECK (jsonb_typeof("unavailableDates") = 'array');

-- ─── Appointment ─────────────────────────────────────────────────────────────

ALTER TABLE IF EXISTS "Appointment"
  -- Nettu-scheduler event ID for this appointment
  ADD COLUMN IF NOT EXISTS "schedulerEventId"   text UNIQUE,

  -- Origin of the booking
  ADD COLUMN IF NOT EXISTS "source"             text DEFAULT 'system',

  -- Cancellation tracking
  ADD COLUMN IF NOT EXISTS "cancelledAt"        timestamptz,
  ADD COLUMN IF NOT EXISTS "cancellationReason" text,

  -- Reschedule tracking
  ADD COLUMN IF NOT EXISTS "rescheduledAt"      timestamptz,
  ADD COLUMN IF NOT EXISTS "rescheduleReason"   text,
  ADD COLUMN IF NOT EXISTS "oldStart"           timestamptz,
  ADD COLUMN IF NOT EXISTS "oldEnd"             timestamptz,

  -- Full audit trail: [{action, oldStart, newStart, actor, reason, timestamp}]
  ADD COLUMN IF NOT EXISTS "auditHistory"       jsonb NOT NULL DEFAULT '[]'::jsonb;

ALTER TABLE IF EXISTS "Appointment"
  DROP CONSTRAINT IF EXISTS appointment_audit_history_is_array;

ALTER TABLE IF EXISTS "Appointment"
  ADD CONSTRAINT appointment_audit_history_is_array
    CHECK (jsonb_typeof("auditHistory") = 'array');

-- ─── Indexes ─────────────────────────────────────────────────────────────────

CREATE INDEX IF NOT EXISTS clinic_scheduler_service_id_idx
  ON "Clinic" ("schedulerServiceId");

CREATE INDEX IF NOT EXISTS doctor_scheduler_doctor_id_idx
  ON "Doctor" ("schedulerDoctorId");

CREATE INDEX IF NOT EXISTS doctor_calendar_key_idx
  ON "Doctor" ("doctorCalendarKey");

CREATE INDEX IF NOT EXISTS appointment_scheduler_event_id_idx
  ON "Appointment" ("schedulerEventId");

CREATE INDEX IF NOT EXISTS appointment_status_idx
  ON "Appointment" (status);

-- ─── Seed: poc-clinic-001 ────────────────────────────────────────────────────
-- Insert a minimal Clinic row for the POC if it does not already exist.
-- The scheduler IDs (schedulerServiceId etc.) are populated later by the
-- setup script; only the stable business columns are set here.

INSERT INTO "Clinic" (id, name, phone, timezone, status)
VALUES ('poc-clinic-001', 'POC Clinic', '+919000000000', 'Asia/Kolkata', 'active')
ON CONFLICT (id) DO NOTHING;

-- Seed doctors — isActive, fullName, feeInr are required by existing queries.
INSERT INTO "Doctor" (id, "clinicId", "fullName", "feeInr", "isActive", "doctorCalendarKey")
VALUES
  ('doc-priya-001', 'poc-clinic-001', 'Dr. Priya', 500, true, 'doc-priya-001_cal'),
  ('doc-rahul-001', 'poc-clinic-001', 'Dr. Rahul', 500, true, 'doc-rahul-001_cal')
ON CONFLICT (id) DO NOTHING;
