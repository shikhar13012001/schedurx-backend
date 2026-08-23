-- Recurring Stripe subscription billing for a clinic's plan (basic/premium/
-- custom), layered onto the existing `Clinic.plan` jsonb intent column
-- (20260821_onboarding.sql) without replacing it — `plan` stays the
-- human-readable planId/addonIds/estimatedMonthlyPaise the dashboard already
-- reads; these new columns are the Stripe-side reality that keeps it synced
-- via stripe-webhook.js's subscription-lifecycle handling.
--
-- Additive only — no existing column is renamed, retyped, or dropped.

ALTER TABLE "Clinic"
  ADD COLUMN IF NOT EXISTS "stripeCustomerId" text,
  ADD COLUMN IF NOT EXISTS "stripeSubscriptionId" text,
  ADD COLUMN IF NOT EXISTS "subscriptionStatus" text
    CHECK ("subscriptionStatus" IN (
      'trialing', 'active', 'past_due', 'canceled',
      'unpaid', 'incomplete', 'incomplete_expired', 'paused'
    )),
  ADD COLUMN IF NOT EXISTS "subscriptionCurrentPeriodEnd" timestamptz,
  -- Maps this subscription's Stripe subscription-item ids back to what
  -- they're for, so an addon can be removed individually later without
  -- listing the subscription from Stripe first. Shape:
  -- { base: { itemId, priceId, planId },
  --   addons: { [addonId]: { itemId, priceId } } }
  ADD COLUMN IF NOT EXISTS "subscriptionItems" jsonb;

CREATE INDEX IF NOT EXISTS "idx_clinic_stripe_customer_id" ON "Clinic" ("stripeCustomerId");
