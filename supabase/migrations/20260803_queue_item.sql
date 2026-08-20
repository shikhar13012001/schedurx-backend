-- Live clinic queue (walk-ins + checked-in appointments), broadcast over
-- Supabase Realtime so the receptionist's drag and the doctor's "now serving"
-- screen update without a page refresh.

CREATE TABLE IF NOT EXISTS "QueueItem" (
  id               text PRIMARY KEY,
  "clinicId"       text NOT NULL REFERENCES "Clinic"(id),
  "doctorId"       text REFERENCES "Doctor"(id),
  "patientId"      text REFERENCES "Patient"(id),
  "appointmentId"  text REFERENCES "Appointment"(id),
  "displayName"    text,
  "phoneNumber"    text,
  status           text NOT NULL DEFAULT 'waiting',
  position         integer NOT NULL DEFAULT 0,
  "walkIn"         boolean NOT NULL DEFAULT false,
  "checkedInAt"    timestamptz NOT NULL DEFAULT now(),
  "calledAt"       timestamptz,
  "completedAt"    timestamptz,
  "createdAt"      timestamptz NOT NULL DEFAULT now(),
  "updatedAt"      timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE IF EXISTS "QueueItem"
  DROP CONSTRAINT IF EXISTS queue_item_status_is_valid;

ALTER TABLE IF EXISTS "QueueItem"
  ADD CONSTRAINT queue_item_status_is_valid
    CHECK (status IN ('waiting', 'in_room', 'done', 'skipped'));

CREATE INDEX IF NOT EXISTS queue_item_clinic_doctor_status_idx
  ON "QueueItem" ("clinicId", "doctorId", status, position);

-- Realtime: add to the publication so postgres_changes subscriptions fire.
-- (duplicate_object is raised if it's already a member — safe to re-run)
DO $$
BEGIN
  ALTER PUBLICATION supabase_realtime ADD TABLE "QueueItem";
EXCEPTION
  WHEN duplicate_object THEN NULL;
  WHEN undefined_object THEN NULL; -- publication doesn't exist on this project/plan yet
END $$;

-- RLS: required once browsers hold a direct Realtime socket. The socket's JWT is
-- minted by this backend (GET /api/v1/realtime-token, signed with
-- SUPABASE_JWT_SECRET) and carries a "clinicId" claim.
ALTER TABLE "QueueItem" ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS queue_item_clinic_isolation ON "QueueItem";

CREATE POLICY queue_item_clinic_isolation ON "QueueItem"
  FOR SELECT
  USING ("clinicId" = (auth.jwt() ->> 'clinicId'));

-- The backend's service-role key bypasses RLS entirely (as it already does for
-- every other table), so writes from the Express app are unaffected by this policy.
