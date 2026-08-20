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

module.exports = { getStaffByFirebaseUid, listStaffForClinic, createStaff };
