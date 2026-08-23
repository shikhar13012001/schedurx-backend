-- Thank-you page CTAs (Phase 7). "review_request" has been a selectable
-- comms-workflow trigger since messaging-threads.sql — mechanically wired
-- through the same delayed-reminder plumbing every other delayed trigger
-- uses — but with nothing for its message template to actually link to.
-- This column is that link; comms-workflow-service.js's data payload gains
-- reviewUrl (from this column) and textCommsUrl (a wa.me deep link into the
-- booking-scoped Thread — see webhooks-twilio.js's BOOKING deep-link fast
-- path, Phase 4) so a workflow template can reference {{reviewUrl}}/
-- {{textCommsUrl}} for the first time.

ALTER TABLE "Clinic"
  ADD COLUMN IF NOT EXISTS "googleReviewUrl" text;
