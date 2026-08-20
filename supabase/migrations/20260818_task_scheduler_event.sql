-- Adds a column so task-service.js can track/cancel a task's nettu-scheduler
-- reminder event (a lightweight, non-busy CalendarEvent created purely to
-- fire a reminder at the task's due time — see task-service.js's
-- maybeCreateReminderEvent/cancelReminderIfAny). Without this, marking a
-- task done or deleting it can't cancel its still-pending reminder.
--
-- No CLI migration runner in this repo — apply via `psql` or the Supabase
-- SQL Editor, per README.md's "Database migrations" section.

ALTER TABLE "Task" ADD COLUMN IF NOT EXISTS "schedulerEventId" text;
