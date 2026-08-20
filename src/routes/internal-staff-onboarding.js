// Bootstrap-only endpoint: creates a Staff row and sets the matching Firebase
// custom claims so subsequent /api/v1/* requests from that Firebase UID carry
// { role, clinicId, doctorId }. Called by an internal admin flow, never by the
// browser directly — mounted behind bearerAuth(INTERNAL_API_KEY), same guard
// as /internal/call-context.

const { Router } = require("express");
const { ok, fail } = require("../lib/response-envelope");
const staffSvc = require("../services/staff-service");
const staffInviteSvc = require("../services/staff-invite-service");
const clinicSvc = require("../services/clinic-service");

function createInternalStaffOnboardingRouter(supabaseClient, firebaseAdminApp) {
  const router = Router();

  // GET /internal/staff/invites/:token — lets the invite-accept page (called
  // via the frontend's server-side proxy, INTERNAL_API_KEY never reaches the
  // browser) show who/what the invite is for before the invitee signs in.
  router.get("/invites/:token", async (req, res) => {
    try {
      const invite = await staffInviteSvc.getInviteByToken(supabaseClient, req.params.token);
      const clinic = await clinicSvc.getClinic(supabaseClient, invite.clinicId);
      return ok(res, { invite: { name: invite.name, role: invite.role, clinicName: clinic?.name ?? null } });
    } catch (err) {
      req.log?.error({ err }, "[internalStaffOnboarding] invite lookup failed");
      return fail(res, err.statusCode ?? 500, err.code ?? "INTERNAL_ERROR", err.message);
    }
  });

  // GET /internal/staff/invites/by-code/:shortCode — resolves a
  // human-typed invite code (screen 1's "Enter invite code" box, before the
  // invitee has a link to tap) to the same invite/token the link uses.
  router.get("/invites/by-code/:shortCode", async (req, res) => {
    try {
      const invite = await staffInviteSvc.getInviteByShortCode(supabaseClient, req.params.shortCode);
      const clinic = await clinicSvc.getClinic(supabaseClient, invite.clinicId);
      return ok(res, { invite: { token: invite.token, name: invite.name, role: invite.role, clinicName: clinic?.name ?? null } });
    } catch (err) {
      req.log?.error({ err }, "[internalStaffOnboarding] invite code lookup failed");
      return fail(res, err.statusCode ?? 500, err.code ?? "INTERNAL_ERROR", err.message);
    }
  });

  // POST /internal/staff/invites/:token/accept — the invitee just signed in
  // with Google (getting a real firebaseUid for the first time), so the
  // Staff row + Firebase custom claims can finally be created.
  router.post("/invites/:token/accept", async (req, res) => {
    const { firebaseUid, email } = req.body ?? {};
    if (!firebaseUid) return fail(res, 422, "MISSING_FIELDS", "firebaseUid is required");

    try {
      const staff = await staffInviteSvc.acceptInvite(supabaseClient, firebaseAdminApp, req.params.token, {
        firebaseUid,
        email,
      });
      return ok(res, { staff }, "Invite accepted — claims will apply on the account's next token refresh");
    } catch (err) {
      req.log?.error({ err }, "[internalStaffOnboarding] invite accept failed");
      return fail(res, err.statusCode ?? 500, err.code ?? "INTERNAL_ERROR", err.message);
    }
  });

  router.post("/", async (req, res) => {
    const { firebaseUid, clinicId, doctorId, email, phone, fullName, role } = req.body ?? {};

    if (!firebaseUid || !clinicId || !role) {
      return fail(res, 422, "MISSING_FIELDS", "firebaseUid, clinicId, and role are required");
    }

    try {
      const staff = await staffSvc.createStaff(supabaseClient, {
        clinicId,
        doctorId,
        firebaseUid,
        email,
        phone,
        fullName,
        role,
      });

      await firebaseAdminApp.setCustomUserClaims(firebaseUid, {
        role: staff.role,
        clinicId: staff.clinicId,
        doctorId: staff.doctorId ?? null,
        fullName: staff.fullName ?? null,
      });

      return ok(res, staff, "Staff onboarded — claims will apply on the account's next token refresh");
    } catch (err) {
      req.log?.error({ err }, "[internalStaffOnboarding] failed");
      return fail(res, err.statusCode ?? 500, err.code ?? "INTERNAL_ERROR", err.message);
    }
  });

  return router;
}

module.exports = { createInternalStaffOnboardingRouter };
