// Clinic data access and scheduling-rule helpers.
// All functions return plain objects; callers decide how to respond.

const { makeId } = require("../lib/ids");
const { validatePlanSelection, estimateMonthlyPaise, PRICE_CONFIG_VERSION } = require("../lib/plans");

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
// practiceType is nullable at the DB level (existing pre-onboarding-era clinics
// have none) but the bootstrap route always supplies it for new clinics.
async function createClinic(
  supabaseClient,
  { name, phone, timezone, workingDays, openingHour, closingHour, practiceType },
) {
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
      practiceType: practiceType ?? null,
      // New clinics created through the onboarding flow start incomplete;
      // pre-onboarding-era rows (and any row created outside this function)
      // keep the column's DEFAULT true, so they're never retroactively
      // forced through the new flow.
      onboardingCompleted: false,
      onboardingStep: "you",
      onboardingStartedAt: now,
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

// ─── Onboarding (post-creation steps — screens 3-7) ────────────────────────────

// Fields the "Clinic" onboarding screen (identity, address, appointment
// defaults, hours, payment methods) is allowed to write — deliberately an
// allowlist, same pattern as doctor-service.js's EDITABLE_FIELDS, so a stray
// body key can never silently patch something like `settings` or `status`.
const CLINIC_PROFILE_FIELDS = [
  "name",
  "phone",
  "email",
  "logoUrl",
  "description",
  "addressLine1",
  "addressLine2",
  "locality",
  "city",
  "state",
  "pincode",
  "landmark",
  "mapsUrl",
  "facilities",
  "paymentMethods",
  "timezone",
  "workingDays",
  "openingHour",
  "closingHour",
  "defaultAppointmentDurationMins",
  "tokenMoneyEnabled",
  "tokenAmountPaise",
];

async function updateClinicProfile(supabaseClient, clinicId, patch) {
  const updates = {};
  for (const field of CLINIC_PROFILE_FIELDS) {
    if (field in patch) updates[field] = patch[field];
  }
  if (Object.keys(updates).length === 0) {
    throw Object.assign(new Error("No editable fields provided"), { code: "MISSING_FIELDS", statusCode: 422 });
  }
  // address/city are the pre-existing flat display fields other code already
  // reads (e.g. patient-facing clinic lookups) — keep them in sync with the
  // new structured fields rather than leaving them stale.
  if ("addressLine1" in updates || "locality" in updates || "city" in updates) {
    const current = await requireActiveClinic(supabaseClient, clinicId);
    const line1 = "addressLine1" in updates ? updates.addressLine1 : current.addressLine1;
    const locality = "locality" in updates ? updates.locality : current.locality;
    const city = "city" in updates ? updates.city : current.city;
    updates.address = [line1, locality].filter(Boolean).join(", ") || current.address;
    updates.city = city ?? current.city;
  }
  updates.updatedAt = new Date().toISOString();

  const { data, error } = await supabaseClient.from("Clinic").update(updates).eq("id", clinicId).select().maybeSingle();
  if (error)
    throw Object.assign(new Error(`DB error updating clinic profile: ${error.message}`), {
      code: "DATABASE_ERROR",
      statusCode: 500,
    });
  if (!data) throw Object.assign(new Error(`Clinic '${clinicId}' not found`), { code: "CLINIC_NOT_FOUND", statusCode: 404 });
  return data;
}

async function updateClinicPlan(supabaseClient, clinicId, { planId, addonIds }) {
  validatePlanSelection({ planId, addonIds });
  const plan = {
    planId,
    addonIds: planId === "custom" ? (addonIds ?? []) : [],
    priceConfigVersion: PRICE_CONFIG_VERSION,
    billingPeriod: "monthly",
    estimatedMonthlyPaise: estimateMonthlyPaise(planId, addonIds ?? []),
  };
  const { data, error } = await supabaseClient
    .from("Clinic")
    .update({ plan, updatedAt: new Date().toISOString() })
    .eq("id", clinicId)
    .select("plan")
    .maybeSingle();
  if (error)
    throw Object.assign(new Error(`DB error saving clinic plan: ${error.message}`), {
      code: "DATABASE_ERROR",
      statusCode: 500,
    });
  if (!data) throw Object.assign(new Error(`Clinic '${clinicId}' not found`), { code: "CLINIC_NOT_FOUND", statusCode: 404 });
  return data.plan;
}

async function updateClinicCallForwarding(supabaseClient, clinicId, { carrier, status }) {
  const VALID_STATUS = ["not_started", "instructions_viewed", "user_confirmed", "skipped"];
  if (status && !VALID_STATUS.includes(status)) {
    throw Object.assign(new Error(`Invalid call-forwarding status '${status}'`), {
      code: "INVALID_STATUS",
      statusCode: 422,
    });
  }
  const callForwarding = { carrier: carrier ?? null, status: status ?? "not_started", updatedAt: new Date().toISOString() };
  const { data, error } = await supabaseClient
    .from("Clinic")
    .update({ callForwarding, updatedAt: new Date().toISOString() })
    .eq("id", clinicId)
    .select("callForwarding")
    .maybeSingle();
  if (error)
    throw Object.assign(new Error(`DB error saving call-forwarding status: ${error.message}`), {
      code: "DATABASE_ERROR",
      statusCode: 500,
    });
  if (!data) throw Object.assign(new Error(`Clinic '${clinicId}' not found`), { code: "CLINIC_NOT_FOUND", statusCode: 404 });
  return data.callForwarding;
}

const ONBOARDING_STEPS = ["you", "clinic", "plan", "calls", "team", "completed"];

async function advanceClinicOnboardingStep(supabaseClient, clinicId, step) {
  if (!ONBOARDING_STEPS.includes(step)) {
    throw Object.assign(new Error(`Invalid onboarding step '${step}'`), { code: "INVALID_STEP", statusCode: 422 });
  }
  const { error } = await supabaseClient
    .from("Clinic")
    .update({ onboardingStep: step, updatedAt: new Date().toISOString() })
    .eq("id", clinicId);
  if (error)
    throw Object.assign(new Error(`DB error advancing onboarding step: ${error.message}`), {
      code: "DATABASE_ERROR",
      statusCode: 500,
    });
}

async function completeClinicOnboarding(supabaseClient, clinicId) {
  const now = new Date().toISOString();
  const { data, error } = await supabaseClient
    .from("Clinic")
    .update({ onboardingCompleted: true, onboardingStep: "completed", onboardingCompletedAt: now, updatedAt: now })
    .eq("id", clinicId)
    .select()
    .maybeSingle();
  if (error)
    throw Object.assign(new Error(`DB error completing onboarding: ${error.message}`), {
      code: "DATABASE_ERROR",
      statusCode: 500,
    });
  if (!data) throw Object.assign(new Error(`Clinic '${clinicId}' not found`), { code: "CLINIC_NOT_FOUND", statusCode: 404 });
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
  updateClinicProfile,
  updateClinicPlan,
  updateClinicCallForwarding,
  advanceClinicOnboardingStep,
  completeClinicOnboarding,
  ONBOARDING_STEPS,
  getClinicSettings,
  updateClinicSettings,
  DEFAULT_RULES,
  DEFAULT_SETTINGS,
};
