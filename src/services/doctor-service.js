// Doctor data access and scheduling-rule helpers.

const { makeId } = require("../lib/ids");

// ─── Creation (onboarding) ──────────────────────────────────────────────────────

// Creates a new Doctor row. Scheduler IDs (nettu user/calendar) are attached
// later by calendarSvc.getOrCreateDoctorCalendar — see internal-clinic-onboarding.js.
async function createDoctor(supabaseClient, { clinicId, fullName, specialty, qualification, feeInr, languages }) {
  const now = new Date().toISOString();
  const { data, error } = await supabaseClient
    .from("Doctor")
    .insert({
      id: makeId("doctor"),
      clinicId,
      fullName,
      specialty: specialty ?? null,
      qualification: qualification ?? null,
      feeInr: feeInr ?? null,
      languages: languages ?? null,
      isActive: true,
      createdAt: now,
      updatedAt: now,
    })
    .select()
    .single();

  if (error)
    throw Object.assign(new Error(`DB error creating doctor: ${error.message}`), {
      code: "DATABASE_ERROR",
      statusCode: 500,
    });
  return data;
}

// Fields a doctor (or clinic owner) can self-serve edit from the Profile
// screen — deliberately narrow: scheduling/booking-affecting fields only,
// not identity fields like fullName or the scheduler linkage.
const EDITABLE_FIELDS = ["feeInr", "slotDurationOverrideMins", "workingHoursStart", "workingHoursEnd", "bio"];

async function updateDoctor(supabaseClient, doctorId, patch) {
  const updates = {};
  for (const field of EDITABLE_FIELDS) {
    if (field in patch) updates[field] = patch[field];
  }
  if (Object.keys(updates).length === 0) {
    throw Object.assign(new Error("No editable fields provided"), { code: "MISSING_FIELDS", statusCode: 422 });
  }
  updates.updatedAt = new Date().toISOString();

  const { data, error } = await supabaseClient.from("Doctor").update(updates).eq("id", doctorId).select().maybeSingle();

  if (error)
    throw Object.assign(new Error(`DB error updating doctor: ${error.message}`), {
      code: "DATABASE_ERROR",
      statusCode: 500,
    });
  if (!data)
    throw Object.assign(new Error(`Doctor '${doctorId}' not found`), { code: "DOCTOR_NOT_FOUND", statusCode: 404 });
  return data;
}

// ─── Onboarding profile (screen 3 — richer than the Profile screen's narrow
// EDITABLE_FIELDS above, since onboarding is the one place the full
// professional-profile/website-feeding fields get written) ────────────────

const MAX_PHOTOS = 5;

const ONBOARDING_PROFILE_FIELDS = [
  "fullName",
  "specialty",
  "qualification",
  "bio",
  "headline",
  "languages",
  "personalPhone",
  "upiId",
  "photos",
  "qualifications",
  "registrations",
  "affiliations",
  "services",
  "awards",
  "memberships",
  "consultationModes",
  "additionalInfo",
  "feeInr",
  "slotDurationOverrideMins",
  "workingHoursStart",
  "workingHoursEnd",
  "workingDaysOverride",
  "breaks",
];

async function updateDoctorOnboardingProfile(supabaseClient, doctorId, patch) {
  const updates = {};
  for (const field of ONBOARDING_PROFILE_FIELDS) {
    if (field in patch) updates[field] = patch[field];
  }
  if ("photos" in updates && Array.isArray(updates.photos) && updates.photos.length > MAX_PHOTOS) {
    throw Object.assign(new Error(`A doctor profile can have at most ${MAX_PHOTOS} photos`), {
      code: "TOO_MANY_PHOTOS",
      statusCode: 422,
    });
  }
  if (Object.keys(updates).length === 0) {
    throw Object.assign(new Error("No editable fields provided"), { code: "MISSING_FIELDS", statusCode: 422 });
  }
  updates.updatedAt = new Date().toISOString();

  const { data, error } = await supabaseClient.from("Doctor").update(updates).eq("id", doctorId).select().maybeSingle();
  if (error)
    throw Object.assign(new Error(`DB error updating doctor profile: ${error.message}`), {
      code: "DATABASE_ERROR",
      statusCode: 500,
    });
  if (!data)
    throw Object.assign(new Error(`Doctor '${doctorId}' not found`), { code: "DOCTOR_NOT_FOUND", statusCode: 404 });
  return data;
}

// ─── Queries ──────────────────────────────────────────────────────────────────

async function getDoctor(supabaseClient, doctorId) {
  const { data, error } = await supabaseClient.from("Doctor").select("*").eq("id", doctorId).maybeSingle();

  if (error) throw Object.assign(new Error(`DB error fetching doctor: ${error.message}`), { code: "DATABASE_ERROR" });
  return data ?? null;
}

// Validates doctor exists, is active, and belongs to the given clinic.
async function requireActiveDoctor(supabaseClient, doctorId, clinicId) {
  const doctor = await getDoctor(supabaseClient, doctorId);

  if (!doctor) {
    throw Object.assign(new Error(`Doctor '${doctorId}' not found`), { code: "DOCTOR_NOT_FOUND", statusCode: 404 });
  }
  if (doctor.clinicId !== clinicId) {
    throw Object.assign(new Error(`Doctor '${doctorId}' does not belong to clinic '${clinicId}'`), {
      code: "DOCTOR_NOT_IN_CLINIC",
      statusCode: 422,
    });
  }
  if (doctor.isActive === false) {
    throw Object.assign(new Error(`Doctor '${doctorId}' is not active`), { code: "DOCTOR_INACTIVE", statusCode: 422 });
  }

  return doctor;
}

// Solo-practice invite rule (see staff-invite-service.js): a Solo workspace
// may have at most one active Doctor. A plain row fetch (not a count-only
// head request) so this behaves identically against both the real client
// and the in-memory test stub, which doesn't implement Supabase's `count`
// option — clinics only ever have a handful of doctors, so this is cheap.
async function countActiveDoctors(supabaseClient, clinicId) {
  const { data, error } = await supabaseClient.from("Doctor").select("id").eq("clinicId", clinicId).eq("isActive", true);
  if (error) throw Object.assign(new Error(`DB error counting doctors: ${error.message}`), { code: "DATABASE_ERROR" });
  return data?.length ?? 0;
}

// Merges doctor-level scheduling rules on top of clinic defaults.
// Doctor fields are only applied when explicitly set (not null/undefined).
function getSchedulingRules(doctor, clinicRules) {
  return {
    timezone: doctor.timezone ?? clinicRules.timezone,
    workingDays: doctor.workingDaysOverride ?? clinicRules.workingDays,
    workingHoursStart: doctor.workingHoursStart ?? `${String(clinicRules.openingHour).padStart(2, "0")}:00`,
    workingHoursEnd: doctor.workingHoursEnd ?? `${String(clinicRules.closingHour).padStart(2, "0")}:00`,
    unavailableDates: doctor.unavailableDates ?? [],
    slotDurationMins: doctor.slotDurationOverrideMins ?? clinicRules.defaultAppointmentDurationMins,
    bufferMins: doctor.bufferOverrideMins ?? clinicRules.bufferMins,
  };
}

// Persist scheduler IDs back to the Doctor row after setup.
async function saveSchedulerIds(supabaseClient, doctorId, { schedulerDoctorId, schedulerCalendarId }) {
  const now = new Date().toISOString();
  const { error } = await supabaseClient
    .from("Doctor")
    .update({ schedulerDoctorId, schedulerCalendarId, updatedAt: now })
    .eq("id", doctorId);

  if (error)
    throw Object.assign(new Error(`DB error saving doctor scheduler IDs: ${error.message}`), {
      code: "DATABASE_ERROR",
    });
}

// ─── Doctor name matching ──────────────────────────────────────────────────────

// Normalise a name for comparison: lowercase, strip leading "Dr."/"Dr ", collapse spaces.
function normaliseName(str) {
  return (str ?? "")
    .toLowerCase()
    .replace(/^dr\.?\s+/i, "")
    .replace(/\s+/g, " ")
    .trim();
}

// Score how well `queryWords` (from the caller's spoken text) match `nameWords`.
function wordOverlapScore(nameWords, queryWords) {
  if (!queryWords.length) return 0;
  const hits = queryWords.filter((qw) => nameWords.some((nw) => nw === qw || nw.startsWith(qw) || qw.startsWith(nw)));
  return hits.length / queryWords.length;
}

// Find the best matching doctor from `doctors` for a spoken `query` like "Dr. Sharma" or "Priya".
// Returns the matched doctor row or null if nothing scores above the 0.5 threshold.
function matchDoctorByName(doctors, query) {
  if (!query || !doctors?.length) return null;

  const normQuery = normaliseName(query);
  const queryWords = normQuery.split(" ").filter(Boolean);

  let best = null;
  let bestScore = 0;

  for (const doc of doctors) {
    const normName = normaliseName(doc.fullName ?? "");
    const nameWords = normName.split(" ").filter(Boolean);

    let score;
    if (normName === normQuery) {
      score = 1.0;
    } else if (normName.includes(normQuery) || normQuery.includes(normName)) {
      score = 0.9;
    } else {
      score = wordOverlapScore(nameWords, queryWords);
    }

    if (score > bestScore) {
      bestScore = score;
      best = doc;
    }
  }

  return bestScore >= 0.5 ? best : null;
}

module.exports = {
  createDoctor,
  updateDoctor,
  updateDoctorOnboardingProfile,
  MAX_PHOTOS,
  getDoctor,
  requireActiveDoctor,
  countActiveDoctors,
  getSchedulingRules,
  saveSchedulerIds,
  matchDoctorByName,
};
