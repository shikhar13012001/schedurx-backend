// Raw DB fetch helpers extracted from tool routes.
// Each function performs exactly one query with no business logic.

const crypto = require("node:crypto");
const { normalizeAppointments } = require("../lib/dates");
const { normalizeIndianMobile } = require("../lib/phone");

function dbErr(msg) {
  return Object.assign(new Error(`DB error ${msg}`), { code: "DATABASE_ERROR", statusCode: 500 });
}

// ─── Doctors ──────────────────────────────────────────────────────────────────

async function listActiveDoctors(supabase, clinicId) {
  // Explicit order matters here beyond display: the frontend falls back to
  // "the first doctor in this list" whenever a staff member's session has no
  // doctorId of its own (e.g. an owner not linked to a specific doctor).
  // Without a stable sort, Postgres/PostgREST don't guarantee row order is
  // consistent between requests, so that fallback could silently resolve to
  // a *different* doctor on every refetch — editing Fee/Slot would then
  // appear to "save the old value" because it's actually now showing a
  // sibling doctor's row, not the one just edited.
  const { data, error } = await supabase
    .from("Doctor")
    .select(
      "id, fullName, specialty, qualification, bio, languages, feeInr, schedulerDoctorId, schedulerCalendarId, " +
        "workingHoursStart, workingHoursEnd, slotDurationOverrideMins, registrations",
    )
    .eq("clinicId", clinicId)
    .eq("isActive", true)
    .order("id", { ascending: true });
  if (error) throw dbErr(`listing doctors: ${error.message}`);
  return data ?? [];
}

// ─── Patients ─────────────────────────────────────────────────────────────────

// Indian mobile numbers are always exactly 10 digits — matching on just the
// last 10 (via an ILIKE suffix) makes lookups format-agnostic, since every
// entry point that captures a phone number (dashboard PhoneField, WhatsApp's
// Twilio "From" header, the public intake form, a manual walk-in entry) has
// historically stored it differently ("+919876543210" vs "919876543210" vs a
// bare "9876543210"). An exact-string match here was the actual root cause of
// "WhatsApp says I have no bookings" — a real patient with real appointments
// booked through the dashboard, messaging from that same number, silently got
// a brand-new empty Patient record instead of finding their own.
function phoneSuffixPattern(phone) {
  const digits = String(phone ?? "").replace(/\D/g, "");
  return `%${digits.slice(-10)}`;
}

async function findPatientByPhone(supabase, clinicId, phone) {
  const { data, error } = await supabase
    .from("Patient")
    .select("*")
    .ilike("contactNumber", phoneSuffixPattern(phone))
    .eq("clinicId", clinicId)
    // Oldest first — if the format-mismatch bug already left duplicate rows
    // for the same person behind, the earliest one is the real record with
    // the actual booking history; later ones are the bug's own artifacts.
    .order("createdAt", { ascending: true })
    .limit(1)
    .maybeSingle();
  if (error) throw dbErr(`finding patient: ${error.message}`);
  return data ?? null;
}

// Genuinely exact — unlike findPatientByPhone's suffix-match "best effort"
// lookup (which can return the wrong person if two numbers happen to share
// their last 10 digits, and never verifies the full number), this is an
// identity-security boundary: the WhatsApp agent's confirm_identity tool
// (Phase 6) uses this, not findPatientByPhone, so it can only ever attach to
// a patient whose full number genuinely matches what the caller just typed.
// Narrows via the same last-10-digit DB filter for efficiency, then verifies
// the complete normalized number matches before returning anything.
async function findPatientByExactPhone(supabase, clinicId, phone) {
  const normalized = normalizeIndianMobile(phone);
  if (!normalized) return null;

  const { data, error } = await supabase
    .from("Patient")
    .select("*")
    .ilike("contactNumber", phoneSuffixPattern(phone))
    .eq("clinicId", clinicId);
  if (error) throw dbErr(`finding patient by exact phone: ${error.message}`);

  return (data ?? []).find((row) => normalizeIndianMobile(row.contactNumber) === normalized) ?? null;
}

async function createPatient(supabase, clinicId, phone) {
  const { data, error } = await supabase
    .from("Patient")
    .insert({
      id: `pat_${crypto.randomUUID()}`,
      clinicId,
      fullName: "",
      contactNumber: phone,
      createdAt: new Date().toISOString(),
    })
    .select()
    .single();
  if (error) throw dbErr(`creating patient: ${error.message}`);
  return data;
}

// Lookup-or-create for the dashboard booking flow, where a name is typically
// captured up front (unlike the voice flow's createPatient, which only has a
// phone number at call-start and fills in the name later via updatePatientFields).
async function findOrCreatePatient(supabase, clinicId, { phone, fullName, age, gender }) {
  const existing = await findPatientByPhone(supabase, clinicId, phone);
  if (existing) {
    if (fullName && !existing.fullName) {
      return updatePatientFields(supabase, existing.id, { fullName });
    }
    return existing;
  }

  const { data, error } = await supabase
    .from("Patient")
    .insert({
      id: `pat_${crypto.randomUUID()}`,
      clinicId,
      fullName: fullName ?? "",
      contactNumber: phone,
      age: age ?? null,
      gender: gender ?? null,
      createdAt: new Date().toISOString(),
    })
    .select()
    .single();
  if (error) throw dbErr(`creating patient: ${error.message}`);
  return data;
}

// Every clinic today shares one platform Twilio WhatsApp number (see
// twilio-client.js's header comment) — Clinic.whatsappFrom is only ever set
// for a clinic with its own dedicated number, which in practice is almost
// none of them. webhooks-twilio.js's whatsapp-inbound handler falls back to
// this when the receiving number doesn't exactly match any clinic, to find
// which clinic(s) this phone number is actually a patient of.
async function findPatientsByPhoneAcrossClinics(supabase, phone) {
  const { data, error } = await supabase
    .from("Patient")
    .select("id, clinicId, fullName, createdAt")
    .ilike("contactNumber", phoneSuffixPattern(phone));
  if (error) throw dbErr(`finding patients by phone: ${error.message}`);
  return data ?? [];
}

async function updatePatientFields(supabase, patientId, patch) {
  let query;
  if (Object.keys(patch).length === 0) {
    query = supabase.from("Patient").select("id, fullName, age, gender, clinicId, contactNumber").eq("id", patientId);
  } else {
    query = supabase
      .from("Patient")
      .update(patch)
      .eq("id", patientId)
      .select("id, fullName, age, gender, clinicId, contactNumber");
  }
  const { data, error } = await query.maybeSingle();
  if (error) throw dbErr(`updating patient: ${error.message}`);
  return data ?? null;
}

// ─── Appointments (REST read layer) ────────────────────────────────────────────

// date is kept as the original single-day shorthand (still used by the
// dashboard's calendar view); dateFrom/dateTo is the more elemental range
// form the assistant's list_appointments tool needs so one query can answer
// "today", "this week", or "everything from here on" alike. status filters
// to one Appointment.status value (booked/tentative/cancelled/completed/
// no_show/blocked) — omitted means no status filtering at all.
async function listAppointmentsForClinic(supabase, clinicId, { date, dateFrom, dateTo, doctorId, patientId, status } = {}) {
  let query = supabase.from("Appointment").select("*").eq("clinicId", clinicId);
  if (doctorId) query = query.eq("doctorId", doctorId);
  if (patientId) query = query.eq("patientId", patientId);
  if (status) query = query.eq("status", status);
  if (date) {
    query = query.gte("timeslot", `${date}T00:00:00`).lt("timeslot", `${date}T23:59:59.999`);
  } else {
    if (dateFrom) query = query.gte("timeslot", `${dateFrom}T00:00:00`);
    if (dateTo) query = query.lt("timeslot", `${dateTo}T23:59:59.999`);
  }
  const { data, error } = await query.order("timeslot", { ascending: true });
  if (error) throw dbErr(`listing appointments: ${error.message}`);
  return normalizeAppointments(data);
}

// Used by the WhatsApp patient agent (whatsapp-agent-tools.js) to answer "what
// are my appointments" without exposing a general by-patient search — the
// caller is always the phone-verified patient themselves. No filter args
// (the default) preserves the original "upcoming, not cancelled" behavior;
// passing status/dateFrom/dateTo replaces those defaults rather than
// narrowing them further, so a patient can also ask about past or
// cancelled visits through the same tool.
async function listUpcomingAppointmentsForPatient(supabase, clinicId, patientId, { status, dateFrom, dateTo } = {}) {
  let query = supabase.from("Appointment").select("*").eq("clinicId", clinicId).eq("patientId", patientId);
  if (status) query = query.eq("status", status);
  else query = query.neq("status", "cancelled");
  if (dateFrom) query = query.gte("timeslot", dateFrom);
  else if (!dateTo) query = query.gte("timeslot", new Date().toISOString());
  if (dateTo) query = query.lt("timeslot", dateTo);
  const { data, error } = await query.order("timeslot", { ascending: true });
  if (error) throw dbErr(`listing upcoming appointments: ${error.message}`);
  return normalizeAppointments(data);
}

// Used by the public patient-facing booking API (api-v1-public.js) — an
// unguessable-id capability model like the team-invite tokens, so the caller
// must supply both ids together, never appointmentId alone.
async function getAppointmentById(supabase, clinicId, appointmentId) {
  const { data, error } = await supabase
    .from("Appointment")
    .select("*")
    .eq("id", appointmentId)
    .eq("clinicId", clinicId)
    .maybeSingle();
  if (error) throw dbErr(`fetching appointment: ${error.message}`);
  return data ? normalizeAppointments([data])[0] : null;
}

// ─── Patients (REST read layer) ────────────────────────────────────────────────

async function getPatientById(supabase, clinicId, patientId) {
  const { data, error } = await supabase
    .from("Patient")
    .select("*")
    .eq("id", patientId)
    .eq("clinicId", clinicId)
    .maybeSingle();
  if (error) throw dbErr(`fetching patient: ${error.message}`);
  return data ?? null;
}

async function listPatientsForClinic(supabase, clinicId) {
  const { data, error } = await supabase
    .from("Patient")
    .select("*")
    .eq("clinicId", clinicId)
    .order("createdAt", { ascending: false });
  if (error) throw dbErr(`listing patients: ${error.message}`);
  const patients = data ?? [];
  if (!patients.length) return patients;

  // A real per-patient visit count and most-recent visit date, not the
  // always-zero/always-blank it was before this list ever fetched Visit
  // rows at all. Grouped in JS (not a SQL join) — same posture as this
  // codebase's other cross-table counts (e.g. listPossibleNoShows in
  // queue-service.js) — one extra query, one small reduce, no fragile join
  // to keep in sync with the schema.
  const { data: visitRows, error: visitErr } = await supabase.from("Visit").select("patientId, visitDate").eq("clinicId", clinicId);
  if (visitErr) throw dbErr(`counting visits: ${visitErr.message}`);
  const countsByPatientId = new Map();
  const lastVisitByPatientId = new Map();
  for (const row of visitRows ?? []) {
    countsByPatientId.set(row.patientId, (countsByPatientId.get(row.patientId) ?? 0) + 1);
    const current = lastVisitByPatientId.get(row.patientId);
    if (row.visitDate && (!current || row.visitDate > current)) lastVisitByPatientId.set(row.patientId, row.visitDate);
  }
  return patients.map((patient) => ({
    ...patient,
    visitsCount: countsByPatientId.get(patient.id) ?? 0,
    lastVisitDate: lastVisitByPatientId.get(patient.id) ?? null,
  }));
}

// Ranked trigram search via the search_patients() SQL function
// (supabase/migrations/20260802_patient_search_index.sql) — keeps this project
// on @supabase/supabase-js only, no raw `pg` driver.
async function searchPatients(supabase, clinicId, q) {
  const { data, error } = await supabase.rpc("search_patients", { p_clinic_id: clinicId, p_query: q });
  if (error) throw dbErr(`searching patients: ${error.message}`);
  return data ?? [];
}

module.exports = {
  listActiveDoctors,
  findPatientByPhone,
  findPatientByExactPhone,
  findPatientsByPhoneAcrossClinics,
  createPatient,
  findOrCreatePatient,
  updatePatientFields,
  listAppointmentsForClinic,
  listUpcomingAppointmentsForPatient,
  getAppointmentById,
  getPatientById,
  listPatientsForClinic,
  searchPatients,
};
