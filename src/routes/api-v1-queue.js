const { Router } = require("express");
const { ok, fail } = require("../lib/response-envelope");
const queueSvc = require("../services/queue-service");
const clinicSvc = require("../services/clinic-service");
const appointmentSvc = require("../services/appointment-service");
const notificationSvc = require("../services/notification-service");

function createApiV1QueueRouter(supabaseClient, twilioClient) {
  const router = Router();

  router.get("/", async (req, res) => {
    try {
      const clinicId = req.staff.clinicId;
      const doctorId = req.query.doctorId;
      const clinic = await clinicSvc.getClinic(supabaseClient, clinicId);
      const graceMinutes = clinic?.settings?.checkIn?.noShowGraceMinutes ?? queueSvc.DEFAULT_NO_SHOW_GRACE_MINUTES;

      const [queue, possibleNoShows] = await Promise.all([
        queueSvc.listQueue(supabaseClient, clinicId, { doctorId }),
        queueSvc.listPossibleNoShows(supabaseClient, clinicId, { doctorId, graceMinutes }),
      ]);
      return ok(res, { queue, possibleNoShows });
    } catch (err) {
      req.log?.error({ err }, "[api-v1:queue] list failed");
      return fail(res, err.statusCode ?? 500, err.code ?? "INTERNAL_ERROR", err.message);
    }
  });

  // Also the "check in a booked patient" entry point — pass appointmentId
  // and doctorId/patientId are derived server-side from the real booking,
  // ignoring whatever the client sent for those (see queue-service.js).
  router.post("/walk-in", async (req, res) => {
    const { doctorId, patientId, displayName, phoneNumber, appointmentId } = req.body ?? {};
    if (!doctorId && !appointmentId) return fail(res, 422, "MISSING_FIELDS", "doctorId or appointmentId is required");

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
      const result = await queueSvc.advance(
        supabaseClient,
        { clinicId: req.staff.clinicId, doctorId, direction, targetId },
        req.log,
        twilioClient,
      );
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

  // Staff-confirmed no-show — never auto-fired. Flips the appointment's own
  // status (appointment-service.js's markNoShow), fires the clinic's
  // configured no_show comms workflow if any, and drops a staff Notification
  // so front desk sees it without having to be looking at the queue tab.
  router.post("/confirm-no-show", async (req, res) => {
    const { appointmentId } = req.body ?? {};
    if (!appointmentId) return fail(res, 422, "MISSING_FIELDS", "appointmentId is required");

    try {
      const clinicId = req.staff.clinicId;
      const result = await appointmentSvc.markNoShow(supabaseClient, { appointmentId, clinicId }, req.log, twilioClient);

      try {
        const who = result.patientName ?? "A patient";
        const whenWho = [result.apptTime, result.doctorName ? `with ${result.doctorName}` : null].filter(Boolean).join(" ");
        await notificationSvc.createNotification(supabaseClient, {
          clinicId,
          staffId: null, // clinic-wide broadcast, same as the nettu "starting soon" reminder
          type: "reminder",
          title: "No-show confirmed",
          body: `${who} didn't check in${whenWho ? ` for ${whenWho}` : ""}.`,
          data: { appointmentId, kind: "no_show" },
        });
      } catch (notifErr) {
        req.log?.warn({ err: notifErr, appointmentId }, "[api-v1:queue] no-show notification failed");
      }

      return ok(res, result);
    } catch (err) {
      req.log?.error({ err }, "[api-v1:queue] confirm-no-show failed");
      return fail(res, err.statusCode ?? 500, err.code ?? "INTERNAL_ERROR", err.message);
    }
  });

  return router;
}

module.exports = { createApiV1QueueRouter };
