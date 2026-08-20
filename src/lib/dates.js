// A handful of pre-existing tables (Appointment, Clinic, Doctor, Patient —
// see docs/live-schema-baseline.md) predate this repo's migrations and still
// use Postgres `timestamp without time zone` columns, unlike every table
// this repo created fresh (`timestamptz` throughout). The app has always
// written genuine UTC instants into those naive columns (every writer here
// uses `new Date().toISOString()`, and the server itself runs in UTC — see
// PRODUCTION_CHECKLIST.md), so the stored digits ARE correct UTC — they're
// just missing the "Z"/offset marker PostgREST would normally add. A client
// that does `new Date(value)` on a marker-less string reinterprets those UTC
// digits as its own local time, silently shifting every timestamp by the
// viewer's UTC offset. Stamp the marker back on before these values leave
// the server. Idempotent — already-marked values pass through unchanged.
const HAS_TZ_MARKER = /(Z|[+-]\d{2}:?\d{2})$/;

function toUtcIso(value) {
  if (!value || typeof value !== "string") return value;
  return HAS_TZ_MARKER.test(value) ? value : `${value}Z`;
}

// Fields on Appointment that predate this repo's timestamptz-everywhere
// convention — see supabase/migrations/20260612_clinic_doctor_calendar.sql's
// header comment: its `ADD COLUMN IF NOT EXISTS ... timestamptz` lines were
// no-ops against these already-existing naive columns.
const APPOINTMENT_TIMESTAMP_FIELDS = [
  "timeslot",
  "createdAt",
  "updatedAt",
  "cancelledAt",
  "rescheduledAt",
  "oldStart",
  "oldEnd",
];

function normalizeAppointment(row) {
  if (!row) return row;
  const normalized = { ...row };
  for (const field of APPOINTMENT_TIMESTAMP_FIELDS) {
    if (field in normalized) normalized[field] = toUtcIso(normalized[field]);
  }
  return normalized;
}

function normalizeAppointments(rows) {
  return (rows ?? []).map(normalizeAppointment);
}

module.exports = { toUtcIso, normalizeAppointment, normalizeAppointments };
