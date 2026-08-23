-- Booking-ID-scoped Thread + doctor isolation (Phase 4). Coexists with —
-- does not replace — today's phone-only Thread model: `scope` distinguishes
-- a general (phone-resolved, one-per-contact) thread from a booking-scoped
-- one (one per Appointment, created via a booking-ID click-to-chat deep
-- link — see webhooks-twilio.js's resolveBookingThread). `doctorId` is
-- denormalized from the linked Appointment.doctorId (not a live join) so
-- doctor-aware filtering in messaging-service.js's listThreads/getThread can
-- be a fast, obviously-correct column comparison instead of a per-row
-- Appointment lookup.
--
-- Additive only — no existing column is renamed, retyped, or dropped.
-- Existing threads default to scope:'general'/doctorId:null, meaning every
-- doctor keeps seeing them exactly as before (see messaging-service.js's
-- isVisibleToStaff: unassigned/general threads stay visible to every doctor
-- at the clinic — this migration doesn't retroactively hide anything).

ALTER TABLE "Thread"
  ADD COLUMN IF NOT EXISTS "appointmentId" text REFERENCES "Appointment"(id),
  ADD COLUMN IF NOT EXISTS "doctorId" text REFERENCES "Doctor"(id),
  ADD COLUMN IF NOT EXISTS "scope" text NOT NULL DEFAULT 'general';

ALTER TABLE IF EXISTS "Thread"
  DROP CONSTRAINT IF EXISTS thread_scope_is_valid;

ALTER TABLE IF EXISTS "Thread"
  ADD CONSTRAINT thread_scope_is_valid
    CHECK (scope IN ('general', 'booking'));

-- findOrCreateBookingThread looks up by (clinicId, appointmentId) — one
-- booking-scoped thread per appointment.
CREATE UNIQUE INDEX IF NOT EXISTS thread_appointment_unique_idx
  ON "Thread" ("appointmentId")
  WHERE "appointmentId" IS NOT NULL;

CREATE INDEX IF NOT EXISTS thread_clinic_doctor_scope_idx
  ON "Thread" ("clinicId", "doctorId", scope);
