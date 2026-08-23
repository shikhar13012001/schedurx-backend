const { Router } = require("express");
const { ok, fail } = require("../lib/response-envelope");
const { requireRole } = require("../middleware/require-role");
const messagingSvc = require("../services/messaging-service");
const tableSvc = require("../services/table-service");

function createApiV1ThreadsRouter(supabaseClient, twilioClient) {
  const router = Router();

  // Lets a staff-facing "message this patient" button (patient profile,
  // billing) resolve straight to a thread instead of needing its own send
  // path — reuses the exact lookup the inbound WhatsApp webhook already does.
  router.post("/find-or-create", async (req, res) => {
    const { patientId } = req.body ?? {};
    if (!patientId) return fail(res, 422, "MISSING_FIELDS", "patientId is required");

    try {
      const patient = await tableSvc.getPatientById(supabaseClient, req.staff.clinicId, patientId);
      if (!patient) return fail(res, 404, "PATIENT_NOT_FOUND", `Patient '${patientId}' not found`);
      if (!patient.contactNumber) {
        return fail(res, 422, "MISSING_PHONE", "This patient has no phone number on file");
      }

      const thread = await messagingSvc.findOrCreateThread(supabaseClient, {
        clinicId: req.staff.clinicId,
        patientId: patient.id,
        contactPhone: patient.contactNumber,
      });
      return ok(res, { thread });
    } catch (err) {
      req.log?.error({ err }, "[api-v1:threads] find-or-create failed");
      return fail(res, err.statusCode ?? 500, err.code ?? "INTERNAL_ERROR", err.message);
    }
  });

  // Doctor isolation (Phase 4): a doctor only sees their own booking-scoped
  // threads plus every general one — see messaging-service.js's
  // isVisibleToStaff for the exact rule. Owner/receptionist are unrestricted.
  function staffContextOf(req) {
    return { role: req.staff.role, doctorId: req.staff.doctorId };
  }

  router.get("/", async (req, res) => {
    try {
      const threads = await messagingSvc.listThreads(supabaseClient, req.staff.clinicId, {
        status: req.query.status,
        staffContext: staffContextOf(req),
      });
      return ok(res, { threads });
    } catch (err) {
      req.log?.error({ err }, "[api-v1:threads] list failed");
      return fail(res, err.statusCode ?? 500, err.code ?? "INTERNAL_ERROR", err.message);
    }
  });

  router.get("/:id/messages", async (req, res) => {
    try {
      await messagingSvc.getThread(supabaseClient, req.staff.clinicId, req.params.id, staffContextOf(req));
      const messages = await messagingSvc.listMessages(supabaseClient, req.params.id);
      return ok(res, { messages });
    } catch (err) {
      req.log?.error({ err }, "[api-v1:threads] list messages failed");
      return fail(res, err.statusCode ?? 500, err.code ?? "INTERNAL_ERROR", err.message);
    }
  });

  // Doctor-only, matching the frontend's existing session.role === "doctor" gate
  // for thread replies — now enforced server-side too. sendReply's own
  // getThread call additionally enforces that a doctor can only reply inside
  // their own booking-scoped threads (or a general one) — this is the actual
  // fix for "any doctor could reply to any other doctor's patient's thread".
  router.post("/:id/messages", requireRole("doctor", "owner"), async (req, res) => {
    const { body } = req.body ?? {};
    if (!body) return fail(res, 422, "MISSING_FIELDS", "body is required");

    try {
      const message = await messagingSvc.sendReply(
        supabaseClient,
        { clinicId: req.staff.clinicId, threadId: req.params.id, staffId: req.staff.staffId, body, staffContext: staffContextOf(req) },
        req.log,
        twilioClient,
      );
      return res.status(201).json({ success: true, data: { message }, message: null });
    } catch (err) {
      req.log?.error({ err }, "[api-v1:threads] send reply failed");
      return fail(res, err.statusCode ?? 500, err.code ?? "INTERNAL_ERROR", err.message);
    }
  });

  // Receptionist-only, matching the frontend's existing session.role === "receptionist" gate.
  router.post("/:id/escalate", requireRole("receptionist", "owner"), async (req, res) => {
    try {
      const thread = await messagingSvc.escalate(supabaseClient, req.staff.clinicId, req.params.id, staffContextOf(req));
      return ok(res, { thread });
    } catch (err) {
      req.log?.error({ err }, "[api-v1:threads] escalate failed");
      return fail(res, err.statusCode ?? 500, err.code ?? "INTERNAL_ERROR", err.message);
    }
  });

  router.patch("/:id/read", async (req, res) => {
    try {
      const thread = await messagingSvc.markRead(supabaseClient, req.staff.clinicId, req.params.id, staffContextOf(req));
      return ok(res, { thread });
    } catch (err) {
      req.log?.error({ err }, "[api-v1:threads] mark read failed");
      return fail(res, err.statusCode ?? 500, err.code ?? "INTERNAL_ERROR", err.message);
    }
  });

  return router;
}

module.exports = { createApiV1ThreadsRouter };
