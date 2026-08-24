-- Delivery status tracking. Until now, "sent" only ever meant "Twilio's
-- create() call returned a sid without throwing" — logged once and
-- forgotten, with no way to know whether a message actually reached the
-- patient. Tonight's incident (a Stripe webhook silently undeliverable for
-- an unknown length of time, and a WhatsApp send that fails routinely
-- outside a 24h session window with only a server-log warning) was the same
-- shape every time: a real failure, invisible until someone happened to
-- notice. MessageLog is the first piece of making that visible — every
-- outbound Twilio send gets a row here, and Twilio's own status-callback
-- webhook (see webhooks-twilio.js's new /status-callback route) updates it
-- with the real delivery outcome as Twilio learns it.

CREATE TABLE IF NOT EXISTS "MessageLog" (
  id             text PRIMARY KEY,
  "clinicId"     text REFERENCES "Clinic"(id),
  "providerSid"  text NOT NULL,
  channel        text NOT NULL,
  "toPhone"      text,
  -- What this send was for — booking_confirmed, token_payment, team_invite,
  -- missed_call_followup, reminder, pre_appointment, post_appointment,
  -- review_request, agent_reply, cancellation, reschedule — free text, not
  -- an enum, since new send sites shouldn't need a migration to be logged.
  purpose        text,
  status         text NOT NULL DEFAULT 'queued',
  "errorCode"    text,
  "errorMessage" text,
  "createdAt"    timestamptz NOT NULL DEFAULT now(),
  "updatedAt"    timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS message_log_provider_sid_idx ON "MessageLog" ("providerSid");
CREATE INDEX IF NOT EXISTS message_log_clinic_status_idx ON "MessageLog" ("clinicId", status);
CREATE INDEX IF NOT EXISTS message_log_status_created_idx ON "MessageLog" (status, "createdAt");

ALTER TABLE IF EXISTS "MessageLog" DROP CONSTRAINT IF EXISTS message_log_channel_is_valid;
ALTER TABLE IF EXISTS "MessageLog"
  ADD CONSTRAINT message_log_channel_is_valid CHECK (channel IN ('sms', 'whatsapp'));

ALTER TABLE IF EXISTS "MessageLog" DROP CONSTRAINT IF EXISTS message_log_status_is_valid;
ALTER TABLE IF EXISTS "MessageLog"
  ADD CONSTRAINT message_log_status_is_valid
    CHECK (status IN ('queued', 'sent', 'delivered', 'undelivered', 'failed', 'read'));
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
