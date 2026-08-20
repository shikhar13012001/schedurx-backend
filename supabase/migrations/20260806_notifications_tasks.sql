-- Staff-facing in-app/push alerts (bell icon, critical-thread nudges). This is
-- deliberately a separate concept from the live "Reminder" table (patient-
-- facing, scheduled SMS/WhatsApp tied to one appointment) — don't consolidate
-- them, they serve different audiences. See docs/live-schema-baseline.md.
CREATE TABLE IF NOT EXISTS "Notification" (
  id          text PRIMARY KEY,
  "clinicId"  text NOT NULL REFERENCES "Clinic"(id),
  "staffId"   text REFERENCES "Staff"(id), -- null = broadcast to the whole clinic
  type        text NOT NULL,
  title       text,
  body        text,
  data        jsonb NOT NULL DEFAULT '{}'::jsonb,
  "readAt"    timestamptz,
  "createdAt" timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS notification_staff_unread_idx
  ON "Notification" ("clinicId", "staffId", "readAt");

CREATE TABLE IF NOT EXISTS "Task" (
  id                  text PRIMARY KEY,
  "clinicId"          text NOT NULL REFERENCES "Clinic"(id),
  "assignedStaffId"   text REFERENCES "Staff"(id),
  "createdByStaffId"  text REFERENCES "Staff"(id),
  title               text NOT NULL,
  description         text,
  "dueAt"             timestamptz,
  status              text NOT NULL DEFAULT 'open',
  priority            text NOT NULL DEFAULT 'normal',
  "viaAI"             boolean NOT NULL DEFAULT false,
  "createdAt"         timestamptz NOT NULL DEFAULT now(),
  "updatedAt"         timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE IF EXISTS "Task"
  DROP CONSTRAINT IF EXISTS task_status_is_valid;

ALTER TABLE IF EXISTS "Task"
  ADD CONSTRAINT task_status_is_valid
    CHECK (status IN ('open', 'done'));

CREATE INDEX IF NOT EXISTS task_clinic_assignee_idx ON "Task" ("clinicId", "assignedStaffId", status);

CREATE TABLE IF NOT EXISTS "PushSubscription" (
  id          text PRIMARY KEY,
  "staffId"   text NOT NULL REFERENCES "Staff"(id),
  endpoint    text NOT NULL UNIQUE,
  keys        jsonb NOT NULL,
  "createdAt" timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS push_subscription_staff_idx ON "PushSubscription" ("staffId");
