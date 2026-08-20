-- Staff accounts for the dashboard (doctor + receptionist login), backing
-- Firebase-authenticated /api/v1/* requests. Role vocabulary matches the
-- frontend's existing session.role values.

CREATE TABLE IF NOT EXISTS "Staff" (
  id            text PRIMARY KEY,
  "clinicId"    text NOT NULL REFERENCES "Clinic"(id),
  "doctorId"    text REFERENCES "Doctor"(id),
  "firebaseUid" text UNIQUE,
  email         text,
  phone         text,
  "fullName"    text,
  role          text NOT NULL,
  "isActive"    boolean NOT NULL DEFAULT true,
  "createdAt"   timestamptz NOT NULL DEFAULT now(),
  "updatedAt"   timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE IF EXISTS "Staff"
  DROP CONSTRAINT IF EXISTS staff_role_is_valid;

ALTER TABLE IF EXISTS "Staff"
  ADD CONSTRAINT staff_role_is_valid
    CHECK (role IN ('doctor', 'receptionist', 'owner'));

CREATE INDEX IF NOT EXISTS staff_clinic_id_idx     ON "Staff" ("clinicId");
CREATE INDEX IF NOT EXISTS staff_clinic_role_idx   ON "Staff" ("clinicId", role);
CREATE UNIQUE INDEX IF NOT EXISTS staff_firebase_uid_idx ON "Staff" ("firebaseUid");
