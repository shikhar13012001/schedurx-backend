-- Resumable clinic onboarding: practice-type branching, a rich doctor
-- profile (feeds the future public doctor website), structured clinic
-- address/appointment/payment settings, recurring breaks, per-person
-- onboarding progress (Clinic = org-level setup, Staff = each person's own
-- short personal-profile step), a persisted (not billed) plan/add-on
-- selection, and call-forwarding setup status.
--
-- CRITICAL: onboardingCompleted defaults to true on both Clinic and Staff so
-- every existing clinic/staff row is treated as already onboarded — nobody
-- gets retroactively redirected into the new flow. Only rows created by the
-- new onboarding start endpoint explicitly set it false.
--
-- Additive only — no existing column is renamed, retyped, or dropped.
-- `Clinic.address`/`city` (pre-existing flat strings) are left as-is and
-- kept in sync from the new structured address fields at write time, so any
-- existing reader of the flat fields keeps working unchanged.

ALTER TABLE "Clinic"
  ADD COLUMN IF NOT EXISTS "practiceType" text CHECK ("practiceType" IN ('solo', 'polyclinic')),
  ADD COLUMN IF NOT EXISTS "onboardingStep" text,
  ADD COLUMN IF NOT EXISTS "onboardingCompleted" boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS "onboardingStartedAt" timestamptz,
  ADD COLUMN IF NOT EXISTS "onboardingCompletedAt" timestamptz,
  ADD COLUMN IF NOT EXISTS "addressLine1" text,
  ADD COLUMN IF NOT EXISTS "addressLine2" text,
  ADD COLUMN IF NOT EXISTS "locality" text,
  ADD COLUMN IF NOT EXISTS "state" text,
  ADD COLUMN IF NOT EXISTS "pincode" text,
  ADD COLUMN IF NOT EXISTS "landmark" text,
  ADD COLUMN IF NOT EXISTS "mapsUrl" text,
  ADD COLUMN IF NOT EXISTS "email" text,
  ADD COLUMN IF NOT EXISTS "description" text,
  ADD COLUMN IF NOT EXISTS "facilities" text[],
  ADD COLUMN IF NOT EXISTS "paymentMethods" text[],
  ADD COLUMN IF NOT EXISTS "tokenMoneyEnabled" boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS "tokenAmountPaise" integer,
  -- Persisted intent only — no real subscription/payment exists yet.
  -- Shape: { planId: "basic"|"premium"|"custom", addonIds: string[],
  --          priceConfigVersion: string, billingPeriod: "monthly",
  --          estimatedMonthlyPaise: number }
  ADD COLUMN IF NOT EXISTS "plan" jsonb,
  -- Shape: { carrier: "jio"|"airtel"|"other"|null,
  --          status: "not_started"|"instructions_viewed"|"user_confirmed"|"skipped",
  --          updatedAt: iso string }
  ADD COLUMN IF NOT EXISTS "callForwarding" jsonb;

ALTER TABLE "Doctor"
  -- Repeatable/structured groups as jsonb arrays, matching this table's
  -- existing convention (unavailableDates, workingDaysOverride) rather than
  -- new tables — none of these need to be queried independently of the
  -- doctor they belong to.
  ADD COLUMN IF NOT EXISTS "headline" text,
  ADD COLUMN IF NOT EXISTS "personalPhone" text,
  ADD COLUMN IF NOT EXISTS "upiId" text,
  ADD COLUMN IF NOT EXISTS "photos" jsonb,
  ADD COLUMN IF NOT EXISTS "qualifications" jsonb,
  ADD COLUMN IF NOT EXISTS "registrations" jsonb,
  ADD COLUMN IF NOT EXISTS "affiliations" jsonb,
  ADD COLUMN IF NOT EXISTS "services" text[],
  ADD COLUMN IF NOT EXISTS "awards" jsonb,
  ADD COLUMN IF NOT EXISTS "memberships" jsonb,
  ADD COLUMN IF NOT EXISTS "consultationModes" text[],
  -- Recurring daily breaks (e.g. lunch) — { label, start, end }[], applied
  -- across every working day rather than materialized as calendar events,
  -- since nettu-scheduler has no recurring-block primitive to push this
  -- into; availability-service.js filters generated slots against it.
  ADD COLUMN IF NOT EXISTS "breaks" jsonb,
  -- The four generic "future flexibility" fields from the spec, kept as one
  -- extensible jsonb object ({field1..field4}) instead of four rigid
  -- top-level columns.
  ADD COLUMN IF NOT EXISTS "additionalInfo" jsonb;

ALTER TABLE "Staff"
  ADD COLUMN IF NOT EXISTS "onboardingStep" text,
  ADD COLUMN IF NOT EXISTS "onboardingCompleted" boolean NOT NULL DEFAULT true,
  -- A receptionist's own working hours/breaks aren't consumed by the
  -- scheduler today (only Doctor's are) — collected for the same
  -- "when are you around" reason the spec gives, ready for a future feature
  -- to read, without inventing a second doctor-shaped table for it.
  ADD COLUMN IF NOT EXISTS "workingDaysOverride" jsonb,
  ADD COLUMN IF NOT EXISTS "workingHoursStart" text,
  ADD COLUMN IF NOT EXISTS "workingHoursEnd" text,
  ADD COLUMN IF NOT EXISTS "breaks" jsonb;

-- A short, shareable code (e.g. "DR7KQ9") alongside StaffInvite's existing
-- long token — the token remains the secure accept-URL credential, this is
-- just for a human to read aloud or type. Nullable/unique so old invite rows
-- (created before this column existed) don't collide.
ALTER TABLE "StaffInvite"
  ADD COLUMN IF NOT EXISTS "shortCode" text UNIQUE;
