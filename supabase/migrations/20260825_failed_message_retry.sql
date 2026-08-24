-- Retry queue for outbound messages that fail with a transient error (rate
-- limits, temporary Twilio/network issues) — NOT for terminal failures like
-- error 63016 (outside the WhatsApp 24h session window, no approved
-- Content Template) or 63007 (channel not enabled), which will fail again
-- for the exact same reason every time and just waste retry cycles; see
-- failed-message-service.js's isRetryableError for the actual classification.
-- Stores the full resend payload (not just a reference) since MessageLog
-- only tracks delivery status, not enough to reconstruct a send.

CREATE TABLE IF NOT EXISTS "FailedMessage" (
  id                 text PRIMARY KEY,
  "clinicId"         text REFERENCES "Clinic"(id),
  channel            text NOT NULL,
  "toPhone"          text NOT NULL,
  "fromPhone"        text,
  body               text,
  "contentSid"       text,
  "contentVariables" jsonb,
  purpose            text,
  attempts           integer NOT NULL DEFAULT 0,
  "maxAttempts"      integer NOT NULL DEFAULT 3,
  status             text NOT NULL DEFAULT 'pending',
  "lastError"        text,
  "nextAttemptAt"    timestamptz NOT NULL DEFAULT now(),
  "createdAt"        timestamptz NOT NULL DEFAULT now(),
  "updatedAt"        timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE IF EXISTS "FailedMessage" DROP CONSTRAINT IF EXISTS failed_message_channel_is_valid;
ALTER TABLE IF EXISTS "FailedMessage"
  ADD CONSTRAINT failed_message_channel_is_valid CHECK (channel IN ('sms', 'whatsapp'));

ALTER TABLE IF EXISTS "FailedMessage" DROP CONSTRAINT IF EXISTS failed_message_status_is_valid;
ALTER TABLE IF EXISTS "FailedMessage"
  ADD CONSTRAINT failed_message_status_is_valid
    CHECK (status IN ('pending', 'retrying', 'resolved', 'exhausted'));

CREATE INDEX IF NOT EXISTS failed_message_due_idx ON "FailedMessage" (status, "nextAttemptAt");
CREATE INDEX IF NOT EXISTS failed_message_clinic_idx ON "FailedMessage" ("clinicId", status);
