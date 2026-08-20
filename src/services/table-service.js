// Raw DB fetch helpers extracted from tool routes.
// Each function performs exactly one query with no business logic.

const crypto = require("node:crypto");
const { normalizeAppointments } = require("../lib/dates");

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
        "workingHoursStart, workingHoursEnd, slotDurationOverrideMins",
    )
    .eq("clinicId", clinicId)
    .eq("isActive", true)
    .order("id", { ascending: true });
  if (error) throw dbErr(`listing doctors: ${error.message}`);
  return data ?? [];
}

// ─── Patients ─────────────────────────────────────────────────────────────────

async function findPatientByPhone(supabase, clinicId, phone) {
  const { data, error } = await supabase
    .from("Patient")
    .select("*")
    .eq("contactNumber", phone)
    .eq("clinicId", clinicId)
    .maybeSingle();
  if (error) throw dbErr(`finding patient: ${error.message}`);
  return data ?? null;
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

async function listAppointmentsForClinic(supabase, clinicId, { date, doctorId } = {}) {
  let query = supabase.from("Appointment").select("*").eq("clinicId", clinicId);
  if (doctorId) query = query.eq("doctorId", doctorId);
  if (date) {
    query = query.gte("timeslot", `${date}T00:00:00`).lt("timeslot", `${date}T23:59:59.999`);
  }
  const { data, error } = await query.order("timeslot", { ascending: true });
  if (error) throw dbErr(`listing appointments: ${error.message}`);
  return normalizeAppointments(data);
}

// Used by the WhatsApp patient agent (whatsapp-agent-tools.js) to answer "what
// are my appointments" without exposing a general by-patient search — the
// caller is always the phone-verified patient themselves.
async function listUpcomingAppointmentsForPatient(supabase, clinicId, patientId) {
  const { data, error } = await supabase
    .from("Appointment")
    .select("*")
    .eq("clinicId", clinicId)
    .eq("patientId", patientId)
    .neq("status", "cancelled")
    .gte("timeslot", new Date().toISOString())
    .order("timeslot", { ascending: true });
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
  return data ?? [];
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
