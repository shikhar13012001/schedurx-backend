-- Consult threads (WhatsApp-channel messaging). Outbound delivery is stubbed
-- in application code today (see src/services/whatsapp-client.js) but the
-- data model is real from day one so wiring in the live WhatsApp Business
-- Cloud API later needs no schema change.

CREATE TABLE IF NOT EXISTS "Thread" (
  id                text PRIMARY KEY,
  "clinicId"        text NOT NULL REFERENCES "Clinic"(id),
  "patientId"       text REFERENCES "Patient"(id),
  channel           text NOT NULL DEFAULT 'whatsapp',
  "contactPhone"    text,
  status            text NOT NULL DEFAULT 'open',
  "assignedStaffId" text REFERENCES "Staff"(id),
  "lastMessageAt"   timestamptz,
  "unreadCount"     integer NOT NULL DEFAULT 0,
  "createdAt"       timestamptz NOT NULL DEFAULT now(),
  "updatedAt"       timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE IF EXISTS "Thread"
  DROP CONSTRAINT IF EXISTS thread_status_is_valid;

ALTER TABLE IF EXISTS "Thread"
  ADD CONSTRAINT thread_status_is_valid
    CHECK (status IN ('open', 'escalated', 'closed'));

CREATE INDEX IF NOT EXISTS thread_clinic_status_idx ON "Thread" ("clinicId", status, "lastMessageAt" DESC);

CREATE TABLE IF NOT EXISTS "ChatMsg" (
  id              text PRIMARY KEY,
  "threadId"      text NOT NULL REFERENCES "Thread"(id),
  direction       text NOT NULL,
  "senderStaffId" text REFERENCES "Staff"(id),
  body            text NOT NULL,
  status          text NOT NULL DEFAULT 'sent',
  "waMessageId"   text,
  "createdAt"     timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE IF EXISTS "ChatMsg"
  DROP CONSTRAINT IF EXISTS chat_msg_direction_is_valid;

ALTER TABLE IF EXISTS "ChatMsg"
  ADD CONSTRAINT chat_msg_direction_is_valid
    CHECK (direction IN ('inbound', 'outbound'));

CREATE INDEX IF NOT EXISTS chat_msg_thread_idx ON "ChatMsg" ("threadId", "createdAt");

-- Raw audit trail of every attempted send/webhook, independent of ChatMsg, so
-- the future real WhatsApp integration has somewhere to log verbatim payloads.
CREATE TABLE IF NOT EXISTS "WaLog" (
  id          text PRIMARY KEY,
  "clinicId"  text NOT NULL REFERENCES "Clinic"(id),
  direction   text NOT NULL,
  payload     jsonb NOT NULL DEFAULT '{}'::jsonb,
  "createdAt" timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS wa_log_clinic_idx ON "WaLog" ("clinicId", "createdAt" DESC);
