-- Cancellation cutoff was a flat 24 hours with no clinic-facing way to
-- change it — a doctor blocking their own calendar last-minute (see
-- appointmentSvc.bookAppointment's new conflict-cancel step) or a patient
-- cancelling same-day both need to work well inside 24 hours. Lowered to 1
-- hour, which still gives the clinic real notice before a no-show risk
-- while not blocking legitimate short-notice cancellations.
--
-- rescheduleCutoffHours is untouched — only cancellations were asked for.

ALTER TABLE "Clinic" ALTER COLUMN "cancellationCutoffHours" SET DEFAULT 1;

-- Retroactive: no clinic has ever had a way to set this away from the
-- previous default, so every existing row is really still "on the
-- default" even though the column itself is NOT NULL DEFAULT 24.
UPDATE "Clinic" SET "cancellationCutoffHours" = 1 WHERE "cancellationCutoffHours" = 24;
