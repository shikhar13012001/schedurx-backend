// Clinic data access and scheduling-rule helpers.
// All functions return plain objects; callers decide how to respond.

const { makeId } = require("../lib/ids");

// Defaults for the dashboard's feature-toggle settings blob — mirrors the
// frontend's seed() defaults in src/stores/index.ts so a freshly onboarded
// clinic behaves the same as the mock demo did.
const DEFAULT_SETTINGS = {
  captureMode: "recap",
  receptionAnalytics: false,
  aiAssistant: true,
  billing: false,
  digitalRx: true,
  autoFollowUp: true,
  viewMode: "simple",
  // No channels/workflows configured by default — a freshly onboarded clinic
  // sends nothing until it opts in via PATCH /api/v1/clinic-settings. See
  // comms-workflow-service.js for the shape workflows[] entries take.
  communication: { channelsEnabled: [], voiceGreetingTemplate: null, workflows: [] },
};

const DEFAULT_RULES = {
  timezone: "Asia/Kolkata",
  workingDays: ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat"],
  openingHour: 9,
  closingHour: 18,
  defaultAppointmentDurationMins: 30,
  bufferMins: 5,
  minNoticeHours: 2,
  maxBookingWindowDays: 14,
  cancellationCutoffHours: 24,
  rescheduleCutoffHours: 24,
};

// ─── Queries ──────────────────────────────────────────────────────────────────

async function getClinic(supabaseClient, clinicId) {
  const { data, error } = await supabaseClient.from("Clinic").select("*").eq("id", clinicId).maybeSingle();

  if (error) throw Object.assign(new Error(`DB error fetching clinic: ${error.message}`), { code: "DATABASE_ERROR" });
  return data ?? null;
}

// Validates clinic exists and is active; throws with a structured code on failure.
async function requireActiveClinic(supabaseClient, clinicId) {
  const clinic = await getClinic(supabaseClient, clinicId);
  if (!clinic) {
    throw Object.assign(new Error(`Clinic '${clinicId}' not found`), { code: "CLINIC_NOT_FOUND", statusCode: 404 });
  }
  if (clinic.status && clinic.status !== "active") {
    throw Object.assign(new Error(`Clinic '${clinicId}' is not active`), { code: "CLINIC_INACTIVE", statusCode: 422 });
  }
  return clinic;
}

// Returns the effective scheduling rules for a clinic, filling defaults for any missing columns.
function getSchedulingRules(clinic) {
  return {
    timezone: clinic.timezone ?? DEFAULT_RULES.timezone,
    workingDays: clinic.workingDays ?? DEFAULT_RULES.workingDays,
    openingHour: clinic.openingHour ?? DEFAULT_RULES.openingHour,
    closingHour: clinic.closingHour ?? DEFAULT_RULES.closingHour,
    defaultAppointmentDurationMins:
      clinic.defaultAppointmentDurationMins ?? DEFAULT_RULES.defaultAppointmentDurationMins,
    bufferMins: clinic.bufferMins ?? DEFAULT_RULES.bufferMins,
    minNoticeHours: clinic.minNoticeHours ?? DEFAULT_RULES.minNoticeHours,
    maxBookingWindowDays: clinic.maxBookingWindowDays ?? DEFAULT_RULES.maxBookingWindowDays,
    cancellationCutoffHours: clinic.cancellationCutoffHours ?? DEFAULT_RULES.cancellationCutoffHours,
    rescheduleCutoffHours: clinic.rescheduleCutoffHours ?? DEFAULT_RULES.rescheduleCutoffHours,
  };
}

// Persist scheduler IDs back to the Clinic row after setup.
async function saveSchedulerIds(supabaseClient, clinicId, { schedulerServiceId }) {
  const now = new Date().toISOString();
  const { error } = await supabaseClient
    .from("Clinic")
    .update({ schedulerServiceId, updatedAt: now })
    .eq("id", clinicId);

  if (error)
    throw Object.assign(new Error(`DB error saving clinic scheduler IDs: ${error.message}`), {
      code: "DATABASE_ERROR",
    });
}

// ─── Creation (onboarding) ──────────────────────────────────────────────────────

// Creates a new Clinic row. Scheduler IDs are attached later by calendarSvc once
// the nettu-scheduler service is provisioned — see internal-clinic-onboarding.js.
async function createClinic(supabaseClient, { name, phone, timezone, workingDays, openingHour, closingHour }) {
  const now = new Date().toISOString();
  const { data, error } = await supabaseClient
    .from("Clinic")
    .insert({
      id: makeId("clinic"),
      name,
      phone: phone ?? null,
      timezone: timezone ?? DEFAULT_RULES.timezone,
      workingDays: workingDays ?? DEFAULT_RULES.workingDays,
      openingHour: openingHour ?? DEFAULT_RULES.openingHour,
      closingHour: closingHour ?? DEFAULT_RULES.closingHour,
      status: "active",
      settings: DEFAULT_SETTINGS,
      createdAt: now,
      updatedAt: now,
    })
    .select()
    .single();

  if (error)
    throw Object.assign(new Error(`DB error creating clinic: ${error.message}`), {
      code: "DATABASE_ERROR",
      statusCode: 500,
    });
  return data;
}

// ─── Settings (dashboard feature toggles) ──────────────────────────────────────

async function getClinicSettings(supabaseClient, clinicId) {
  const clinic = await requireActiveClinic(supabaseClient, clinicId);
  return clinic.settings ?? {};
}

async function updateClinicSettings(supabaseClient, clinicId, patch) {
  const current = await getClinicSettings(supabaseClient, clinicId);
  const merged = { ...current, ...patch };

  const { data, error } = await supabaseClient
    .from("Clinic")
    .update({ settings: merged, updatedAt: new Date().toISOString() })
    .eq("id", clinicId)
    .select("settings")
    .single();

  if (error)
    throw Object.assign(new Error(`DB error saving clinic settings: ${error.message}`), {
      code: "DATABASE_ERROR",
      statusCode: 500,
    });
  return data.settings;
}

module.exports = {
  getClinic,
  requireActiveClinic,
  getSchedulingRules,
  saveSchedulerIds,
  createClinic,
  getClinicSettings,
  updateClinicSettings,
  DEFAULT_RULES,
  DEFAULT_SETTINGS,
};
