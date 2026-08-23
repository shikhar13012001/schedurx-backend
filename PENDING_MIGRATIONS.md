# Pending migrations (apply before the next droplet deploy)

These five migrations landed in `main` (Phases 2, 3, 4, 6, 7 of the
WhatsApp-on-plans + Stripe billing plan) but have **not** been applied to
production Supabase — this session has no Postgres DDL access (only the
REST/service-role credentials), so they need to be run manually via the
Supabase SQL Editor, in order:

1. `supabase/migrations/20260823_stripe_subscriptions.sql`
2. `supabase/migrations/20260824_pending_booking.sql`
3. `supabase/migrations/20260824_thread_booking_scope.sql`
4. `supabase/migrations/20260824_thread_confirmed_patient.sql`
5. `supabase/migrations/20260824_clinic_google_review_url.sql`

All are additive (`ADD COLUMN IF NOT EXISTS` / `CREATE TABLE IF NOT
EXISTS`) — safe to run against the live database with no downtime, and
safe to re-run if one partially applies.

**Convenience**: `scripts/pending-migrations-combined.sql` is the same five
files concatenated in this order — paste that one file into the SQL Editor
instead of running five separately. It's a snapshot, not a generator; if
any of the five migration files change, regenerate it by hand before
relying on it again.

## Why this blocks a deploy, not just a "nice to have"

The code already pushed to `main` (Phases 4 and 6 especially) writes rows
that reference the new columns unconditionally — e.g.
`messaging-service.js`'s `findOrCreateThread`, which runs on **every**
inbound WhatsApp message, now inserts `appointmentId`/`doctorId`/`scope`.
Deploying this code to the droplet before these migrations run would break
inbound WhatsApp entirely (every insert failing with a PostgREST "unknown
column" error), not just leave the new features inert. Don't redeploy the
droplet until all five have been applied.

## After applying

1. Deploy the droplet (`git pull` + restart — same as every earlier phase
   this session).
2. Run `node scripts/eval-whatsapp-agent.js` (see that file's header) — the
   Phase 8 live adversarial stress test — against the real deployed system.
   Iterate on any real bugs it finds and re-run until clean.
