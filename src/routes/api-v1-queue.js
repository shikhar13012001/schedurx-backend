const { Router } = require("express");
const { ok, fail } = require("../lib/response-envelope");
const queueSvc = require("../services/queue-service");

function createApiV1QueueRouter(supabaseClient) {
  const router = Router();

  router.get("/", async (req, res) => {
    try {
      const queue = await queueSvc.listQueue(supabaseClient, req.staff.clinicId, { doctorId: req.query.doctorId });
      return ok(res, { queue });
    } catch (err) {
      req.log?.error({ err }, "[api-v1:queue] list failed");
      return fail(res, err.statusCode ?? 500, err.code ?? "INTERNAL_ERROR", err.message);
    }
  });

  router.post("/walk-in", async (req, res) => {
    const { doctorId, patientId, displayName, phoneNumber, appointmentId } = req.body ?? {};
    if (!doctorId) return fail(res, 422, "MISSING_FIELDS", "doctorId is required");

    try {
      const queueItem = await queueSvc.addWalkIn(supabaseClient, {
        clinicId: req.staff.clinicId,
        doctorId,
        patientId,
        displayName,
        phoneNumber,
        appointmentId,
      });
      return res.status(201).json({ success: true, data: { queueItem }, message: null });
    } catch (err) {
      req.log?.error({ err }, "[api-v1:queue] walk-in failed");
      return fail(res, err.statusCode ?? 500, err.code ?? "INTERNAL_ERROR", err.message);
    }
  });

  router.post("/advance", async (req, res) => {
    const { doctorId, direction, targetId } = req.body ?? {};
    if (!doctorId || !direction) return fail(res, 422, "MISSING_FIELDS", "doctorId and direction are required");

    try {
      const result = await queueSvc.advance(supabaseClient, {
        clinicId: req.staff.clinicId,
        doctorId,
        direction,
        targetId,
      });
      return ok(res, result);
    } catch (err) {
      req.log?.error({ err }, "[api-v1:queue] advance failed");
      return fail(res, err.statusCode ?? 500, err.code ?? "INTERNAL_ERROR", err.message);
    }
  });

  router.patch("/order", async (req, res) => {
    const { ids } = req.body ?? {};
    if (!Array.isArray(ids)) return fail(res, 422, "MISSING_FIELDS", "ids must be an array");

    try {
      const queue = await queueSvc.reorder(supabaseClient, { clinicId: req.staff.clinicId, ids });
      return ok(res, { queue });
    } catch (err) {
      req.log?.error({ err }, "[api-v1:queue] reorder failed");
      return fail(res, err.statusCode ?? 500, err.code ?? "INTERNAL_ERROR", err.message);
    }
  });

  return router;
}

module.exports = { createApiV1QueueRouter };
