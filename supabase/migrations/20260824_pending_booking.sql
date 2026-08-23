-- Pay-first token payments (Phase 3): a clinic can require a token payment
-- before a booking is confirmed (Clinic.tokenMoneyEnabled/tokenAmountPaise,
-- from 20260821_onboarding.sql). Until now that flag had zero consumers —
-- bookings went straight into "Appointment" regardless. PendingBooking holds
-- the slot (a real nettu-scheduler busy event, created immediately so nobody
-- else can double-book it) and the booking details until Stripe confirms
-- payment; only then does appointment-service.js's finalizePendingBooking
-- turn it into a real Appointment row. Server-only table — no browser ever
-- queries this directly, so no RLS/Realtime wiring (unlike QueueItem).

CREATE TABLE IF NOT EXISTS "PendingBooking" (
  id                       text PRIMARY KEY,
  "clinicId"               text NOT NULL REFERENCES "Clinic"(id),
  "doctorId"               text NOT NULL REFERENCES "Doctor"(id),
  -- Generated at hold time and reused as the eventual Appointment's own id —
  -- it's already embedded in the nettu busy event's metadata (reminders,
  -- webhooks-nettu.js lookups), so the real Appointment row must carry the
  -- same id once payment confirms rather than minting a new one.
  "appointmentId"          text NOT NULL,
  "schedulerEventId"       text,
  timeslot                 timestamptz NOT NULL,
  "durationMinutes"        integer NOT NULL,
  "amountPaise"            integer NOT NULL,
  -- Everything persistAppointment() needs besides the slot itself: patientId,
  -- patient {name,phone,email}, appointmentType, reason, notes,
  -- bookerRelation, proxyName, mode, source.
  "bookingParams"          jsonb NOT NULL,
  status                   text NOT NULL DEFAULT 'pending',
  "stripeCheckoutSessionId" text,
  "expiresAt"              timestamptz NOT NULL,
  "createdAt"              timestamptz NOT NULL DEFAULT now(),
  "updatedAt"              timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE IF EXISTS "PendingBooking"
  DROP CONSTRAINT IF EXISTS pending_booking_status_is_valid;

ALTER TABLE IF EXISTS "PendingBooking"
  ADD CONSTRAINT pending_booking_status_is_valid
    CHECK (status IN ('pending', 'completed', 'expired', 'cancelled'));

CREATE INDEX IF NOT EXISTS pending_booking_status_expires_idx
  ON "PendingBooking" (status, "expiresAt");

CREATE INDEX IF NOT EXISTS pending_booking_clinic_idx
  ON "PendingBooking" ("clinicId");
