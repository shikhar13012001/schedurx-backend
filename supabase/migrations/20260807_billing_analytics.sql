-- Invoice: the new payment record, provider-agnostic by design. Legacy
-- Razorpay columns (Clinic.razorpayKeyId/razorpayKeySecret,
-- Appointment.razorpayOrderId/razorpayPaymentId — see
-- docs/live-schema-baseline.md) are left untouched and not migrated here;
-- this table is where all payments are tracked going forward, identified by
-- (provider, providerReference) regardless of which gateway processed them.
CREATE TABLE IF NOT EXISTS "Invoice" (
  id                          text PRIMARY KEY,
  "clinicId"                  text NOT NULL REFERENCES "Clinic"(id),
  "patientId"                 text REFERENCES "Patient"(id),
  "appointmentId"             text REFERENCES "Appointment"(id),
  "visitId"                   text REFERENCES "Visit"(id),
  "amountInr"                 numeric NOT NULL,
  status                      text NOT NULL DEFAULT 'pending',
  provider                    text NOT NULL DEFAULT 'stripe',
  -- Canonical transaction id, whichever gateway processed the payment
  -- (Stripe payment_intent id today; a Razorpay/cash/other reference if
  -- ever needed later). This — not a gateway-specific column — is the
  -- durable "identify this payment" field.
  "providerReference"         text,
  -- Raw webhook payload, kept for support/debugging/reconciliation.
  "providerMetadata"          jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- Stripe-specific: the Checkout Session id is how the webhook finds this
  -- row before a payment_intent exists yet, so it stays as its own column
  -- rather than being folded into providerReference.
  "stripeCheckoutSessionId"   text,
  "paidAt"                    timestamptz,
  "createdAt"                 timestamptz NOT NULL DEFAULT now(),
  "updatedAt"                 timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE IF EXISTS "Invoice"
  DROP CONSTRAINT IF EXISTS invoice_status_is_valid;
ALTER TABLE IF EXISTS "Invoice"
  ADD CONSTRAINT invoice_status_is_valid
    CHECK (status IN ('pending', 'paid', 'failed', 'refunded'));

ALTER TABLE IF EXISTS "Invoice"
  DROP CONSTRAINT IF EXISTS invoice_provider_is_valid;
ALTER TABLE IF EXISTS "Invoice"
  ADD CONSTRAINT invoice_provider_is_valid
    CHECK (provider IN ('stripe', 'razorpay', 'cash', 'other'));

CREATE INDEX IF NOT EXISTS invoice_clinic_status_idx ON "Invoice" ("clinicId", status, "createdAt" DESC);

CREATE UNIQUE INDEX IF NOT EXISTS invoice_stripe_session_idx
  ON "Invoice" ("stripeCheckoutSessionId") WHERE "stripeCheckoutSessionId" IS NOT NULL;

-- Identifies a payment durably, and doubles as webhook-retry idempotency: a
-- duplicate checkout.session.completed can't create a second paid record
-- for the same underlying transaction.
CREATE UNIQUE INDEX IF NOT EXISTS invoice_provider_reference_idx
  ON "Invoice" (provider, "providerReference") WHERE "providerReference" IS NOT NULL;

-- Daily rollup for the /api/v1/analytics endpoints. Refreshed on-demand from
-- the analytics service (no cron dependency introduced for this) rather than
-- on a schedule — acceptable staleness at this scale.
CREATE MATERIALIZED VIEW IF NOT EXISTS day_stats AS
SELECT
  a."clinicId"                                     AS "clinicId",
  date_trunc('day', a.timeslot)::date              AS day,
  count(*)                                         AS appointments,
  -- Named for what it actually measures today (cancelled bookings) — not a
  -- true no-show signal, which doesn't exist yet (that will come from
  -- QueueItem.status = 'skipped' once the live queue is in use).
  count(*) FILTER (WHERE a.status = 'cancelled')   AS cancellations,
  count(DISTINCT a."patientId")                    AS "uniquePatients",
  coalesce(sum(i."amountInr") FILTER (WHERE i.status = 'paid'), 0) AS revenue
FROM "Appointment" a
LEFT JOIN "Invoice" i ON i."appointmentId" = a.id
GROUP BY a."clinicId", date_trunc('day', a.timeslot)::date;

CREATE UNIQUE INDEX IF NOT EXISTS day_stats_clinic_day_idx ON day_stats ("clinicId", day);

CREATE OR REPLACE FUNCTION refresh_day_stats()
RETURNS void
LANGUAGE sql
AS $$
  REFRESH MATERIALIZED VIEW CONCURRENTLY day_stats;
$$;
