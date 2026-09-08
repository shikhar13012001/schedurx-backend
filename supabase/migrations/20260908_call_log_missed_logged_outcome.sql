-- Adds a dedicated 'missed_logged' outcome for the Android missed-call
-- safety net's log-only mode (DEVICE_MISSED_CALL_SEND_FOLLOWUP off —
-- missed-call-service.js). The existing 'info' outcome is the AI voice
-- agent's "answered a question, no booking action" case — a different
-- scenario that happens to share the same generic name. Nothing in
-- production writes to CallLog with 'info' today (the voice/WhatsApp agents
-- don't write to this table yet — see use-history.ts's header comment), so
-- this is a clean addition, not a meaning change for any existing data.

ALTER TABLE IF EXISTS "CallLog"
  DROP CONSTRAINT IF EXISTS call_log_outcome_is_valid;

ALTER TABLE IF EXISTS "CallLog"
  ADD CONSTRAINT call_log_outcome_is_valid
    CHECK (outcome IN ('booked', 'rescheduled', 'reminder_confirmed', 'recovered_missed', 'missed_logged', 'info'));
