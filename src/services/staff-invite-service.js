// Real team-invite lifecycle — see the StaffInvite migration's comment for
// why this can't just reuse internal-staff-onboarding.js's bootstrap route
// (it requires a firebaseUid the invitee doesn't have yet).

const crypto = require("node:crypto");
const { makeId } = require("../lib/ids");
const staffSvc = require("./staff-service");
const doctorSvc = require("./doctor-service");
const clinicSvc = require("./clinic-service");

const INVITE_TTL_DAYS = 7;

// Avoids visually-confusing characters (0/O, 1/I/L) in the human-readable
// short code — the long `token` above remains the real security credential,
// this is just something a person can read aloud or type without ambiguity.
const SHORT_CODE_ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";
function makeShortCode() {
  let code = "";
  for (let i = 0; i < 6; i++) code += SHORT_CODE_ALPHABET[crypto.randomInt(SHORT_CODE_ALPHABET.length)];
  return code;
}

function dbErr(msg) {
  return Object.assign(new Error(`DB error ${msg}`), { code: "DATABASE_ERROR", statusCode: 500 });
}

// StaffInvite.token is stored hashed, not plaintext — a DB read (leaked
// backup, over-broad export) shouldn't hand over usable access to every
// pending invite. The raw token is still what's ever emailed/texted/put in
// a URL; this is only how it's compared against what's stored.
function hashToken(token) {
  return crypto.createHash("sha256").update(token).digest("hex");
}

// Solo-practice rule: at most one active doctor per clinic, ever — enforced
// here (invite creation) rather than only at accept-time, so the inviter
// gets an immediate, honest error instead of generating a link that will
// fail for the invitee days later.
async function assertCanInviteRole(supabaseClient, clinicId, role) {
  if (role !== "doctor") return;
  const clinic = await clinicSvc.getClinic(supabaseClient, clinicId);
  if (clinic?.practiceType !== "solo") return;
  const doctorCount = await doctorSvc.countActiveDoctors(supabaseClient, clinicId);
  if (doctorCount >= 1) {
    throw Object.assign(new Error("This is a solo practice — it already has a doctor."), {
      code: "SOLO_DOCTOR_LIMIT",
      statusCode: 422,
    });
  }
}

async function createInvite(supabaseClient, { clinicId, invitedByStaffId, name, phone, role, doctorId }) {
  if (!["doctor", "receptionist"].includes(role)) {
    throw Object.assign(new Error(`Invalid role '${role}'`), { code: "INVALID_ROLE", statusCode: 422 });
  }
  await assertCanInviteRole(supabaseClient, clinicId, role);

  const token = crypto.randomBytes(24).toString("hex");
  const shortCode = makeShortCode();
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
      token: hashToken(token),
      shortCode,
      status: "pending",
      createdAt: now.toISOString(),
      expiresAt: expiresAt.toISOString(),
    })
    .select()
    .single();
  if (error) throw dbErr(`creating invite: ${error.message}`);
  // The raw token exists only right here — it's never recoverable from the
  // stored hash again, same as a password. The caller needs it once, to put
  // in the invite link it's about to send.
  return { ...data, token };
}

function assertRedeemable(data) {
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

// `credential` is normally the raw token from an invite link. The
// short-code lookup flow (getInviteByShortCode below) can't hand back
// something that resolves via this same path anymore now that token is
// hashed — a hash isn't reversible, so there's no raw value left to return.
// It hands back the invite's own id instead (a random UUID, similar
// unguessable strength to the token, and reaching that response already
// required guessing the correct short code — same gate the raw token sat
// behind before). Matching on `id` too here means the frontend's existing
// accept-by-token call site keeps working unchanged for that path.
async function getInviteByToken(supabaseClient, credential) {
  // Two separate .eq() lookups, not one .or("token.eq.X,id.eq.Y") — that
  // string gets parsed as a PostgREST filter expression, so interpolating
  // unsanitized user input into it directly would let a crafted credential
  // (commas, dots, operator syntax) manipulate the filter itself.
  const { data: byToken, error: tokenErr } = await supabaseClient
    .from("StaffInvite").select("*").eq("token", hashToken(credential)).maybeSingle();
  if (tokenErr) throw dbErr(`fetching invite: ${tokenErr.message}`);
  if (byToken) return assertRedeemable(byToken);

  const { data: byId, error: idErr } = await supabaseClient
    .from("StaffInvite").select("*").eq("id", credential).maybeSingle();
  if (idErr) throw dbErr(`fetching invite: ${idErr.message}`);
  return assertRedeemable(byId);
}

// Resolves the short, human-typeable code (e.g. "DR7KQ9") to the same invite
// the long token identifies — for the "enter invite code" box on the account
// screen, before the invitee has a link to tap.
async function getInviteByShortCode(supabaseClient, shortCode) {
  const { data, error } = await supabaseClient
    .from("StaffInvite")
    .select("*")
    .eq("shortCode", shortCode.toUpperCase())
    .maybeSingle();
  if (error) throw dbErr(`fetching invite by code: ${error.message}`);
  return assertRedeemable(data);
}

// Creates the real Staff row now that a firebaseUid finally exists (the
// invitee just signed in), sets Firebase custom claims, and marks the
// invite accepted. firebaseAdminApp is the caller's responsibility to pass
// through, same division as internal-staff-onboarding.js.
//
// An invited doctor with no pre-assigned doctorId gets a fresh Doctor row
// here (mirroring internal-clinic-onboarding.js's bootstrap) — otherwise
// they'd have role "doctor" with nothing to actually schedule against.
// Both the new Staff row and (if created) Doctor row start with their own
// onboarding incomplete, so the invitee lands in their own short
// You → Hours → Enter flow instead of being treated as already set up.
async function acceptInvite(supabaseClient, firebaseAdminApp, token, { firebaseUid, email }) {
  const invite = await getInviteByToken(supabaseClient, token);

  let doctorId = invite.doctorId ?? null;
  if (invite.role === "doctor" && !doctorId) {
    await assertCanInviteRole(supabaseClient, invite.clinicId, "doctor"); // re-check at accept time, not just invite time
    const doctor = await doctorSvc.createDoctor(supabaseClient, {
      clinicId: invite.clinicId,
      fullName: invite.name,
    });
    doctorId = doctor.id;
  }

  const staff = await staffSvc.createStaff(supabaseClient, {
    clinicId: invite.clinicId,
    doctorId,
    firebaseUid,
    email,
    phone: invite.phone,
    fullName: invite.name,
    role: invite.role,
  });

  const { error: staffOnboardingErr } = await supabaseClient
    .from("Staff")
    .update({ onboardingCompleted: false, onboardingStep: "you" })
    .eq("id", staff.id);
  if (staffOnboardingErr) throw dbErr(`starting staff onboarding: ${staffOnboardingErr.message}`);

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

  return { ...staff, doctorId, onboardingCompleted: false, onboardingStep: "you" };
}

module.exports = { createInvite, getInviteByToken, getInviteByShortCode, acceptInvite, hashToken };
