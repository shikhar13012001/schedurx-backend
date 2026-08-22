const { Router } = require("express");
const { ok, fail } = require("../lib/response-envelope");
const { requireRole } = require("../middleware/require-role");
const tableSvc = require("../services/table-service");
const staffSvc = require("../services/staff-service");
const staffInviteSvc = require("../services/staff-invite-service");
const clinicSvc = require("../services/clinic-service");
const { normalizeIndianMobile } = require("../lib/phone");
const { config } = require("../config");

function deliveryResult(result) {
  const failed = ["failed", "undelivered"].includes(result?.status);
  return {
    status: failed ? "failed" : (result?.status ?? "queued"),
    providerMessageId: result?.sid ?? null,
  };
}

async function sendInviteChannel({ channel, send }, log) {
  try {
    return { channel, ...deliveryResult(await send()) };
  } catch (err) {
    log?.warn({ err, channel }, `[api-v1:team] ${channel} invite send failed — invite still created`);
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
            }
          : { to: normalizedPhone, from: clinic?.whatsappFrom, body };

        delivery = await Promise.all([
          sendInviteChannel({ channel: "whatsapp", send: () => twilioClient.sendWhatsApp(whatsappOptions) }, req.log),
          sendInviteChannel(
            { channel: "sms", send: () => twilioClient.sendSms({ to: normalizedPhone, body }) },
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

  return router;
}

module.exports = { createApiV1TeamRouter };
