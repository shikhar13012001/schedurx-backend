# Live Supabase schema baseline (`schedurx-calendar` project)

Recorded 2026-08-05, after directly introspecting the live database. This is
**reference only** — nothing here is executed. It exists so nobody has to
redo this detective work later, and so `supabase/migrations/*.sql` can stay
purely additive (`ADD COLUMN IF NOT EXISTS` etc.) against a known-accurate
starting point instead of guessing.

Do not assume this stays accurate forever — re-verify with a real
`information_schema.columns` query before relying on it for anything
consequential.

## Core tables (pre-existing, not created by any migration in this repo)

### `Clinic`
`id, name, address, city, phone, logoUrl, razorpayKeyId, razorpayKeySecret,
twilioAccountSid, twilioAuthToken, whatsappFrom, reminderTemplate24h,
reminderTemplate1h, remindersEnabled, createdAt, schedulerServiceId,
timezone, workingDays, openingHour, closingHour,
defaultAppointmentDurationMins, bufferMins, minNoticeHours,
maxBookingWindowDays, cancellationCutoffHours, rescheduleCutoffHours,
status, updatedAt`

### `Doctor`
`id, clinicId, fullName, specialty, qualification, bio, languages (text[],
**not** jsonb), avatarUrl, micrositeSlug, feeInr, isActive, createdAt,
doctorCalendarKey, schedulerDoctorId, schedulerCalendarId, timezone,
workingDaysOverride, workingHoursStart, workingHoursEnd, unavailableDates
(jsonb), slotDurationOverrideMins, bufferOverrideMins, updatedAt`

### `Patient`
`id, clinicId, fullName, contactNumber, age, gender, createdAt`

### `Appointment`
`id, clinicId, patientId, doctorId, bookerRelation, proxyName, symptoms,
notes, timeslot, durationMinutes, status (default 'tentative'),
razorpayOrderId, razorpayPaymentId, createdAt, updatedAt, schedulerEventId,
source, cancelledAt, cancellationReason, rescheduledAt, rescheduleReason,
oldStart, oldEnd, auditHistory (jsonb)`

Live seed data confirmed matching `20260612_clinic_doctor_calendar.sql`'s
seed block exactly: `Clinic.id = 'poc-clinic-001'` ("Dr. Sharma's Clinic"),
doctors `doc-priya-001` (Priya Sharma) and `doc-rahul-001` (Rahul Mehta).

## Dormant tables — exist live, zero code in `schedurx-backend`, deliberately not modified by any migration here

- **`AppointmentHistory`** (`id, appointmentId, recordedAt, title,
  consultationNotes, prescription jsonb, followupDate, recordedBy`) — 0
  rows. Origin unexplained (not found in `schedurx-backend`,
  `schedurx-ultravox-demo-api`, or `schedurx-calling-agent`). Conceptually
  overlaps with the new `Visit` table added by
  `20260804_visit_and_clinic_settings.sql`, but `Visit` was kept as a
  separate clean table rather than extending this one — see that
  migration's header comment for the reasoning.
- **`Reminder`** (`id, appointmentId, type, channel, scheduledAt, sentAt,
  status`) — 0 rows. Origin also unexplained. This is **patient-facing**
  (a scheduled outbound SMS/WhatsApp reminder tied to one appointment) and
  is a different concept from the new **staff-facing** `Notification` table
  (`20260806_notifications_tasks.sql`) — both are intentionally kept. A
  future recall/reminder-sending feature should write to this existing
  table, not invent another one.
- **`phone_calls`** (snake_case; `local_call_id, created_at, updated_at,
  state, twilio_call_sid, twilio_account_sid, twilio_from, twilio_to,
  twilio_direction, twilio_status, twilio_initial_payload jsonb,
  twilio_status_events jsonb, ultravox_call_id, ultravox_join_url,
  ultravox_status, ultravox_events jsonb, last_error jsonb`) — 29 real
  rows. Confirmed origin: `schedurx-ultravox-demo-api`'s own migration
  (`supabase/migrations/20260610_create_phone_calls.sql` in that repo) and
  repository code (`src/repositories/supabase-call-repository.js`). That
  repo's runtime logs show only local one-off test runs (hostname
  `shikhar_victus`, port 3005) — it does not appear to have ever been
  deployed. The confirmed **live production voice agent**
  (`schedurx-calling-agent`, running as `schedurx-agent.service` on the
  droplet) has **zero Supabase/Postgres footprint** — it doesn't read or
  write this table, or any table, directly.

## Legacy payment columns — left in place, not migrated

`Clinic.razorpayKeyId`/`razorpayKeySecret` and
`Appointment.razorpayOrderId`/`razorpayPaymentId` predate the switch to
Stripe. They're historical/dormant, not dropped, not backfilled into the
new `Invoice` table. Going forward, `Invoice.provider` +
`Invoice.providerReference` is the durable way to identify which gateway
processed a given payment (see `20260807_billing_analytics.sql`).

## Extensions installed
`pg_stat_statements, pgcrypto, plpgsql, supabase_vault, uuid-ossp`.
`pg_trgm` was **not** installed as of this baseline —
`20260802_patient_search_index.sql` installs it.

## Custom functions
`set_current_timestamp_updated_at` — a pre-existing trigger function (not
yet confirmed which tables use it as an actual trigger). This repo's
services set `updatedAt` explicitly from application code everywhere
instead of relying on it, for consistency with the rest of the codebase's
existing convention.
