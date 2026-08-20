-- Appointment.patientId predates this repo's migrations (see
-- docs/live-schema-baseline.md) and carries a NOT NULL constraint on the live
-- database — but appointment-service.js's bookAppointment() has always
-- accepted patientId: null for time-blocking (a block has no patient), and
-- POST /api/v1/appointments/block relies on exactly that. The constraint and
-- the code disagree; this migration brings the constraint in line with the
-- code's actual (and intended) contract.
--
-- Safe to run: relaxing NOT NULL never rejects existing rows (all of which
-- already have a non-null patientId). No CLI migration runner in this repo —
-- apply via `psql` or the Supabase SQL Editor, per README.md's "Database
-- migrations" section.

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'Appointment' AND column_name = 'patientId' AND is_nullable = 'NO'
  ) THEN
    ALTER TABLE "Appointment" ALTER COLUMN "patientId" DROP NOT NULL;
  END IF;
END $$;
