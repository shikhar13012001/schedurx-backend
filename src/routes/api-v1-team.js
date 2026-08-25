const { Router } = require("express");
const { ok, fail } = require("../lib/response-envelope");
const { requireRole } = require("../middleware/require-role");
const tableSvc = require("../services/table-service");
const staffSvc = require("../services/staff-service");
const staffInviteSvc = require("../services/staff-invite-service");
const clinicSvc = require("../services/clinic-service");
const failedMessageSvc = require("../services/failed-message-service");
const { normalizeIndianMobile } = require("../lib/phone");
const { config } = require("../config");

function deliveryResult(result) {
  const failed = ["failed", "undelivered"].includes(result?.status);
  return {
    status: failed ? "failed" : (result?.status ?? "queued"),
    providerMessageId: result?.sid ?? null,
  };
}

// retryPayload carries whatever enqueue() needs to actually resend this
// exact message later — send() itself only returns Twilio's result, not the
// options it was called with, so this is passed alongside rather than
// reconstructed from send's return value.
async function sendInviteChannel({ channel, send, retryPayload }, supabaseClient, log) {
  try {
    return { channel, ...deliveryResult(await send()) };
  } catch (err) {
    log?.warn({ err, channel }, `[api-v1:team] ${channel} invite send failed — invite still created`);
    await failedMessageSvc.enqueue(supabaseClient, { channel, purpose: "team_invite", error: err, ...retryPayload }, log);
    return { channel, status: "failed", providerMessageId: null, errorCode: err.code ?? null };
  }
}

// GET /api/v1/team — doctors (scheduling identities) + staff (login identities),
// combined for the Team screen. ?role=doctor|receptionist filters staff only.
function createApiV1TeamRouter(supabaseClient, twilioClient) {
  const router = Router();

  router.get("/", async (req, res) => {
    try {
      const [doctors, staff] = await Promise.all([
        tableSvc.listActiveDoctors(supabaseClient, req.staff.clinicId),
        staffSvc.listStaffForClinic(supabaseClient, req.staff.clinicId, { role: req.query.role }),
      ]);
      return ok(res, { doctors, staff });
    } catch (err) {
      req.log?.error({ err }, "[api-v1:team] list failed");
      return fail(res, err.statusCode ?? 500, err.code ?? "INTERNAL_ERROR", err.message);
    }
  });

  // POST /api/v1/team/invites — creates a pending invite and sends the
  // accept link independently over WhatsApp and SMS. Doctor/owner only (both currently arrive as role "doctor" —
  // see fromApiStaff on the frontend), matching the reply/escalate gate shape.
  router.post("/invites", requireRole("doctor", "owner"), async (req, res) => {
    const { name, phone, role, doctorId } = req.body ?? {};
    if (!phone || !role) return fail(res, 422, "MISSING_FIELDS", "phone and role are required");
    const normalizedPhone = normalizeIndianMobile(phone);
    if (!normalizedPhone) {
      return fail(res, 422, "INVALID_PHONE", "Enter a valid 10-digit Indian mobile number");
    }

    try {
      const invite = await staffInviteSvc.createInvite(supabaseClient, {
        clinicId: req.staff.clinicId,
        invitedByStaffId: req.staff.staffId,
        name,
        phone: normalizedPhone,
        role,
        doctorId,
      });

      let delivery = [];
      if (twilioClient && config.DASHBOARD_BASE_URL) {
        const clinic = await clinicSvc.getClinic(supabaseClient, req.staff.clinicId);
        const link = `${config.DASHBOARD_BASE_URL}/invite/${invite.token}`;
        const body = `You've been invited to join ${clinic?.name ?? "the clinic"} on ScheduRx as a ${role}. Tap to join: ${link}`;
        const whatsappOptions = config.TWILIO_TEAM_INVITE_CONTENT_SID
          ? {
              to: normalizedPhone,
              from: clinic?.whatsappFrom,
              contentSid: config.TWILIO_TEAM_INVITE_CONTENT_SID,
              contentVariables: { 1: clinic?.name ?? "the clinic", 2: role, 3: link },
              clinicId: req.staff.clinicId,
              purpose: "team_invite",
            }
          : { to: normalizedPhone, from: clinic?.whatsappFrom, body, clinicId: req.staff.clinicId, purpose: "team_invite" };

        delivery = await Promise.all([
          sendInviteChannel(
            {
              channel: "whatsapp",
              send: () => twilioClient.sendWhatsApp(whatsappOptions),
              retryPayload: {
                clinicId: req.staff.clinicId,
                toPhone: normalizedPhone,
                fromPhone: clinic?.whatsappFrom,
                body: config.TWILIO_TEAM_INVITE_CONTENT_SID ? undefined : body,
                contentSid: config.TWILIO_TEAM_INVITE_CONTENT_SID || undefined,
                contentVariables: config.TWILIO_TEAM_INVITE_CONTENT_SID ? { 1: clinic?.name ?? "the clinic", 2: role, 3: link } : undefined,
              },
            },
            supabaseClient,
            req.log,
          ),
          sendInviteChannel(
            {
              channel: "sms",
              send: () => twilioClient.sendSms({ to: normalizedPhone, body, clinicId: req.staff.clinicId, purpose: "team_invite" }),
              retryPayload: { clinicId: req.staff.clinicId, toPhone: normalizedPhone, body },
            },
            supabaseClient,
            req.log,
          ),
        ]);
      }

      return res.status(201).json({ success: true, data: { invite, delivery }, message: null });
    } catch (err) {
      req.log?.error({ err }, "[api-v1:team] create invite failed");
      return fail(res, err.statusCode ?? 500, err.code ?? "INTERNAL_ERROR", err.message);
    }
  });

  // PATCH /api/v1/team/:staffId/deactivate — revokes a staff member's
  // access immediately (see staff-service.js's deactivateStaff / firebase-
  // auth.js's isActive check). Owner-only, and an owner can't deactivate
  // themselves — that'd lock the clinic out with no one left who can undo it.
  router.patch("/:staffId/deactivate", requireRole("owner"), async (req, res) => {
    if (req.params.staffId === req.staff.staffId) {
      return fail(res, 422, "CANNOT_DEACTIVATE_SELF", "You can't deactivate your own account");
    }
    try {
      const staff = await staffSvc.deactivateStaff(supabaseClient, req.staff.clinicId, req.params.staffId);
      return ok(res, { staff });
    } catch (err) {
      req.log?.error({ err }, "[api-v1:team] deactivate failed");
      return fail(res, err.statusCode ?? 500, err.code ?? "INTERNAL_ERROR", err.message);
    }
  });

  return router;
}

module.exports = { createApiV1TeamRouter };
