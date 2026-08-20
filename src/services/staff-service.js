// Staff account data access — the dashboard-login counterpart to Doctor (which
// stays scheduling-only). One Staff row per logged-in person; role is
// 'doctor' | 'receptionist' | 'owner', matching the frontend's session.role values.

const { makeId } = require("../lib/ids");

function dbErr(msg) {
  return Object.assign(new Error(`DB error ${msg}`), { code: "DATABASE_ERROR", statusCode: 500 });
}

async function getStaffByFirebaseUid(supabaseClient, firebaseUid) {
  const { data, error } = await supabaseClient.from("Staff").select("*").eq("firebaseUid", firebaseUid).maybeSingle();

  if (error) throw dbErr(`fetching staff: ${error.message}`);
  return data ?? null;
}

async function listStaffForClinic(supabaseClient, clinicId, { role } = {}) {
  let query = supabaseClient.from("Staff").select("*").eq("clinicId", clinicId).eq("isActive", true);
  if (role) query = query.eq("role", role);

  const { data, error } = await query;
  if (error) throw dbErr(`listing staff: ${error.message}`);
  return data ?? [];
}

// Creates the Staff row. Setting the matching Firebase custom claims is the
// caller's responsibility (routes/internal-staff-onboarding.js) — this function
// only touches Supabase, mirroring every other service in this project.
async function createStaff(supabaseClient, { clinicId, doctorId, firebaseUid, email, phone, fullName, role }) {
  if (!["doctor", "receptionist", "owner"].includes(role)) {
    throw Object.assign(new Error(`Invalid role '${role}'`), { code: "INVALID_ROLE", statusCode: 422 });
  }

  const now = new Date().toISOString();
  const { data, error } = await supabaseClient
    .from("Staff")
    .insert({
      id: makeId("staff"),
      clinicId,
      doctorId: doctorId ?? null,
      firebaseUid,
      email: email ?? null,
      phone: phone ?? null,
      fullName: fullName ?? null,
      role,
      isActive: true,
      createdAt: now,
      updatedAt: now,
    })
    .select()
    .single();

  if (error) throw dbErr(`creating staff: ${error.message}`);
  return data;
}

async function getStaffById(supabaseClient, staffId) {
  const { data, error } = await supabaseClient.from("Staff").select("*").eq("id", staffId).maybeSingle();
  if (error) throw dbErr(`fetching staff: ${error.message}`);
  return data ?? null;
}

// ─── Onboarding (personal profile — screen 3, receptionist branch, and the
// personal-hours section shared by both roles) ─────────────────────────────

const STAFF_ONBOARDING_FIELDS = ["fullName", "phone", "workingDaysOverride", "workingHoursStart", "workingHoursEnd", "breaks"];

async function updateStaffOnboardingProfile(supabaseClient, staffId, patch) {
  const updates = {};
  for (const field of STAFF_ONBOARDING_FIELDS) {
    if (field in patch) updates[field] = patch[field];
  }
  if (Object.keys(updates).length === 0) {
    throw Object.assign(new Error("No editable fields provided"), { code: "MISSING_FIELDS", statusCode: 422 });
  }
  updates.updatedAt = new Date().toISOString();

  const { data, error } = await supabaseClient.from("Staff").update(updates).eq("id", staffId).select().maybeSingle();
  if (error) throw dbErr(`updating staff profile: ${error.message}`);
  if (!data) throw Object.assign(new Error(`Staff '${staffId}' not found`), { code: "STAFF_NOT_FOUND", statusCode: 404 });
  return data;
}

const STAFF_ONBOARDING_STEPS = ["hours", "completed"];

async function advanceStaffOnboardingStep(supabaseClient, staffId, step) {
  if (!STAFF_ONBOARDING_STEPS.includes(step)) {
    throw Object.assign(new Error(`Invalid onboarding step '${step}'`), { code: "INVALID_STEP", statusCode: 422 });
  }
  const { error } = await supabaseClient
    .from("Staff")
    .update({ onboardingStep: step, updatedAt: new Date().toISOString() })
    .eq("id", staffId);
  if (error) throw dbErr(`advancing staff onboarding step: ${error.message}`);
}

async function completeStaffOnboarding(supabaseClient, staffId) {
  const { data, error } = await supabaseClient
    .from("Staff")
    .update({ onboardingCompleted: true, onboardingStep: "completed", updatedAt: new Date().toISOString() })
    .eq("id", staffId)
    .select()
    .maybeSingle();
  if (error) throw dbErr(`completing staff onboarding: ${error.message}`);
  if (!data) throw Object.assign(new Error(`Staff '${staffId}' not found`), { code: "STAFF_NOT_FOUND", statusCode: 404 });
  return data;
}

module.exports = {
  getStaffByFirebaseUid,
  getStaffById,
  listStaffForClinic,
  createStaff,
  updateStaffOnboardingProfile,
  advanceStaffOnboardingStep,
  completeStaffOnboarding,
  STAFF_ONBOARDING_STEPS,
};
