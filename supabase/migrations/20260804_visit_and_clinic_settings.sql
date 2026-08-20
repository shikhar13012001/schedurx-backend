-- Visit: the clinical record produced when a doctor actually sees a patient.
-- NOT the same thing as Appointment.auditHistory, which only logs booking
-- events (created/rescheduled/cancelled) and carries no clinical content.

CREATE TABLE IF NOT EXISTS "Visit" (
  id               text PRIMARY KEY,
  "clinicId"       text NOT NULL REFERENCES "Clinic"(id),
  "patientId"      text NOT NULL REFERENCES "Patient"(id),
  "doctorId"       text REFERENCES "Doctor"(id),
  "appointmentId"  text REFERENCES "Appointment"(id),
  "visitDate"      date NOT NULL DEFAULT current_date,
  mode             text,
  symptoms         text,
  notes            text,
  prescription     jsonb NOT NULL DEFAULT '[]'::jsonb,
  vitals           jsonb NOT NULL DEFAULT '{}'::jsonb,
  "followUpDate"   date,
  status           text NOT NULL DEFAULT 'open',
  "createdAt"      timestamptz NOT NULL DEFAULT now(),
  "updatedAt"      timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE IF EXISTS "Visit"
  DROP CONSTRAINT IF EXISTS visit_prescription_is_array;

ALTER TABLE IF EXISTS "Visit"
  ADD CONSTRAINT visit_prescription_is_array
    CHECK (jsonb_typeof(prescription) = 'array');

CREATE INDEX IF NOT EXISTS visit_clinic_patient_idx ON "Visit" ("clinicId", "patientId", "visitDate" DESC);
CREATE INDEX IF NOT EXISTS visit_clinic_doctor_idx  ON "Visit" ("clinicId", "doctorId", "visitDate" DESC);

-- Per-clinic feature toggles (billing, digitalRx, receptionAnalytics, aiAssistant,
-- autoFollowUp, captureMode, viewMode) — same jsonb-column convention already
-- used for Clinic.workingDays / Doctor.unavailableDates.
ALTER TABLE IF EXISTS "Clinic"
  ADD COLUMN IF NOT EXISTS "settings" jsonb NOT NULL DEFAULT '{}'::jsonb;
