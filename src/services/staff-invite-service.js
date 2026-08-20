// Real team-invite lifecycle — see the StaffInvite migration's comment for
// why this can't just reuse internal-staff-onboarding.js's bootstrap route
// (it requires a firebaseUid the invitee doesn't have yet).

const crypto = require("node:crypto");
const { makeId } = require("../lib/ids");
const staffSvc = require("./staff-service");

const INVITE_TTL_DAYS = 7;

function dbErr(msg) {
  return Object.assign(new Error(`DB error ${msg}`), { code: "DATABASE_ERROR", statusCode: 500 });
}

async function createInvite(supabaseClient, { clinicId, invitedByStaffId, name, phone, role, doctorId }) {
  if (!["doctor", "receptionist"].includes(role)) {
    throw Object.assign(new Error(`Invalid role '${role}'`), { code: "INVALID_ROLE", statusCode: 422 });
  }
  const token = crypto.randomBytes(24).toString("hex");
  const now = new Date();
  const expiresAt = new Date(now.getTime() + INVITE_TTL_DAYS * 24 * 60 * 60 * 1000);

  const { data, error } = await supabaseClient
    .from("StaffInvite")
    .insert({
      id: makeId("invite"),
      clinicId,
      invitedByStaffId: invitedByStaffId ?? null,
      name: name ?? null,
      phone,
      role,
      doctorId: doctorId ?? null,
      token,
      status: "pending",
      createdAt: now.toISOString(),
      expiresAt: expiresAt.toISOString(),
    })
    .select()
    .single();
  if (error) throw dbErr(`creating invite: ${error.message}`);
  return data;
}

async function getInviteByToken(supabaseClient, token) {
  const { data, error } = await supabaseClient.from("StaffInvite").select("*").eq("token", token).maybeSingle();
  if (error) throw dbErr(`fetching invite: ${error.message}`);
  if (!data) throw Object.assign(new Error("Invite not found"), { code: "INVITE_NOT_FOUND", statusCode: 404 });
  if (data.status !== "pending") {
    throw Object.assign(new Error("This invite has already been used"), {
      code: "INVITE_ALREADY_USED",
      statusCode: 410,
    });
  }
  if (data.expiresAt && new Date(data.expiresAt).getTime() < Date.now()) {
    throw Object.assign(new Error("This invite has expired"), { code: "INVITE_EXPIRED", statusCode: 410 });
  }
  return data;
}

// Creates the real Staff row now that a firebaseUid finally exists (the
// invitee just signed in), sets Firebase custom claims, and marks the
// invite accepted. firebaseAdminApp is the caller's responsibility to pass
// through, same division as internal-staff-onboarding.js.
async function acceptInvite(supabaseClient, firebaseAdminApp, token, { firebaseUid, email }) {
  const invite = await getInviteByToken(supabaseClient, token);

  const staff = await staffSvc.createStaff(supabaseClient, {
    clinicId: invite.clinicId,
    doctorId: invite.doctorId,
    firebaseUid,
    email,
    phone: invite.phone,
    fullName: invite.name,
    role: invite.role,
  });

  await firebaseAdminApp.setCustomUserClaims(firebaseUid, {
    role: staff.role,
    clinicId: staff.clinicId,
    doctorId: staff.doctorId ?? null,
    fullName: staff.fullName ?? null,
  });

  const { error } = await supabaseClient
    .from("StaffInvite")
    .update({ status: "accepted", acceptedAt: new Date().toISOString() })
    .eq("id", invite.id);
  if (error) throw dbErr(`marking invite accepted: ${error.message}`);

  return staff;
}

module.exports = { createInvite, getInviteByToken, acceptInvite };
