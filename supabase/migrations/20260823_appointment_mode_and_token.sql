-- The booking form has always collected consultation mode (clinic/video/
-- audio/text) and whether the patient should get a token-payment lock link,
-- but Appointment had no columns to persist either — both were silently
-- discarded between the form and the API call (booking-sheet.tsx's
-- onSubmit never sent them), so the UI could show a Video appointment with
-- "token link sent" while the row underneath was a plain in-clinic booking
-- with no payment intent at all.
--
-- tokenRequested is deliberately separate from the existing
-- razorpayOrderId/razorpayPaymentId columns: those track an actual payment
-- attempt/completion, this tracks the booker's *intent* to require one,
-- which can exist before any Razorpay order is even created.
--
-- Additive only, matching every other migration in this repo.

ALTER TABLE "Appointment"
  ADD COLUMN IF NOT EXISTS "mode" text NOT NULL DEFAULT 'clinic' CHECK ("mode" IN ('clinic', 'video', 'audio', 'text')),
  ADD COLUMN IF NOT EXISTS "tokenRequested" boolean NOT NULL DEFAULT false;
