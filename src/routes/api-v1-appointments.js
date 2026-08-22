const { Router } = require("express");
const { ok, fail } = require("../lib/response-envelope");
const tableSvc = require("../services/table-service");
const appointmentSvc = require("../services/appointment-service");
const availabilitySvc = require("../services/availability-service");

// GET /api/v1/appointments?date=YYYY-MM-DD&doctorId=... — clinicId always comes
// from req.staff (set by firebaseAuth), never from the query string.
// POST /api/v1/appointments — dashboard booking (reuses the same bookAppointment()
// the voice-agent tool uses, so nettu-scheduler conflict detection/booking-window
// rules apply identically regardless of who's booking).
function createApiV1AppointmentsRouter(supabaseClient, nettuClient, twilioClient) {
  const router = Router();

  router.get("/", async (req, res) => {
    const { date, doctorId } = req.query;
    try {
      const appointments = await tableSvc.listAppointmentsForClinic(supabaseClient, req.staff.clinicId, {
        date,
        doctorId,
      });
      return ok(res, { appointments });
    } catch (err) {
      req.log?.error({ err }, "[api-v1:appointments] list failed");
      return fail(res, err.statusCode ?? 500, err.code ?? "INTERNAL_ERROR", err.message);
    }
  });

  // GET /api/v1/appointments/slots?doctorId=&date= — real nettu-scheduler
  // availability (excludes existing appointments/blocks), the staff-facing
  // twin of GET /api/v1/public/slots. Existed for the patient booking API
  // but not here — the dashboard's own booking sheet only ever computed
  // slots from clinic hours and slot length, with no idea what was already
  // taken, so an already-booked time stayed selectable right up until the
  // server rejected it after the whole form was filled out.
  router.get("/slots", async (req, res) => {
    if (!nettuClient) return fail(res, 503, "SCHEDULER_NOT_CONFIGURED", "Calendar scheduling is not configured");

    const { doctorId, date } = req.query;
    if (!doctorId) return fail(res, 422, "MISSING_FIELDS", "doctorId is required");
    try {
      const result = await availabilitySvc.getAvailableSlots(
        nettuClient,
        supabaseClient,
        { clinicId: req.staff.clinicId, doctorId, date },
        req.log,
      );
      return ok(res, result);
    } catch (err) {
      req.log?.error({ err }, "[api-v1:appointments] get slots failed");
      return fail(res, err.statusCode ?? 500, err.code ?? "INTERNAL_ERROR", err.message);
    }
  });

  router.post("/", async (req, res) => {
    if (!nettuClient) {
      return fail(res, 503, "SCHEDULER_NOT_CONFIGURED", "Calendar scheduling is not configured");
    }

    const { doctorId, start, end, reason, notes, bookerRelation, proxyName, patient, mode, tokenRequested } = req.body ?? {};
    if (!doctorId || !start || !patient?.phone) {
      return fail(res, 422, "MISSING_FIELDS", "doctorId, start, and patient.phone are required");
    }

    try {
      const patientRow = await tableSvc.findOrCreatePatient(supabaseClient, req.staff.clinicId, {
        phone: patient.phone,
        fullName: patient.name,
        age: patient.age,
        gender: patient.gender,
      });

      const appointment = await appointmentSvc.bookAppointment(
        nettuClient,
        supabaseClient,
        {
          clinicId: req.staff.clinicId,
          doctorId,
          patientId: patientRow.id,
          start,
          end,
          patient: { name: patientRow.fullName, phone: patientRow.contactNumber },
          reason,
          notes,
          bookerRelation,
          proxyName,
          mode,
          tokenRequested,
          source: "reception",
        },
        req.log,
        twilioClient,
      );

      return res.status(201).json({ success: true, data: { appointment, patient: patientRow }, message: null });
    } catch (err) {
      req.log?.error({ err }, "[api-v1:appointments] create failed");
      return fail(res, err.statusCode ?? 500, err.code ?? "INTERNAL_ERROR", err.message);
    }
  });

  // POST /api/v1/appointments/block — reserves time on a doctor's real
  // calendar with no patient attached. Creates a real nettu busy event (not
  // just a local UI flag) so a genuine 409 SLOT_NOT_AVAILABLE surfaces if a
  // real booking already exists there, rather than silently overwriting it.
  router.post("/block", async (req, res) => {
    if (!nettuClient) {
      return fail(res, 503, "SCHEDULER_NOT_CONFIGURED", "Calendar scheduling is not configured");
    }

    const { doctorId, start, end, reason } = req.body ?? {};
    if (!doctorId || !start) {
      return fail(res, 422, "MISSING_FIELDS", "doctorId and start are required");
    }

    try {
      const appointment = await appointmentSvc.bookAppointment(
        nettuClient,
        supabaseClient,
        {
          clinicId: req.staff.clinicId,
          doctorId,
          patientId: null,
          start,
          end,
          notes: reason,
          status: "blocked",
          source: "reception",
        },
        req.log,
      );
      return res.status(201).json({ success: true, data: { appointment }, message: null });
    } catch (err) {
      req.log?.error({ err }, "[api-v1:appointments] block failed");
      return fail(res, err.statusCode ?? 500, err.code ?? "INTERNAL_ERROR", err.message);
    }
  });

  // PATCH /api/v1/appointments/:id — staff-facing reschedule. Reuses the same
  // appointmentSvc.rescheduleAppointment the voice-agent and WhatsApp patient
  // agent already call, so cutoff/conflict rules apply identically regardless
  // of who's rescheduling.
  router.patch("/:id", async (req, res) => {
    if (!nettuClient) {
      return fail(res, 503, "SCHEDULER_NOT_CONFIGURED", "Calendar scheduling is not configured");
    }

    const { doctorId, newStart, newEnd, reason } = req.body ?? {};
    if (!doctorId || !newStart) {
      return fail(res, 422, "MISSING_FIELDS", "doctorId and newStart are required");
    }

    try {
      const result = await appointmentSvc.rescheduleAppointment(
        nettuClient,
        supabaseClient,
        { appointmentId: req.params.id, clinicId: req.staff.clinicId, doctorId, newStart, newEnd, reason, source: "reception" },
        req.log,
        twilioClient,
      );
      return ok(res, result);
    } catch (err) {
      req.log?.error({ err }, "[api-v1:appointments] reschedule failed");
      return fail(res, err.statusCode ?? 500, err.code ?? "INTERNAL_ERROR", err.message);
    }
  });

  // DELETE /api/v1/appointments/:id — staff-facing cancel.
  router.delete("/:id", async (req, res) => {
    if (!nettuClient) {
      return fail(res, 503, "SCHEDULER_NOT_CONFIGURED", "Calendar scheduling is not configured");
    }

    try {
      const result = await appointmentSvc.cancelAppointment(
        nettuClient,
        supabaseClient,
        { appointmentId: req.params.id, clinicId: req.staff.clinicId, reason: req.body?.reason, source: "reception" },
        req.log,
        twilioClient,
      );
      return ok(res, result);
    } catch (err) {
      req.log?.error({ err }, "[api-v1:appointments] cancel failed");
      return fail(res, err.statusCode ?? 500, err.code ?? "INTERNAL_ERROR", err.message);
    }
  });

  return router;
}

module.exports = { createApiV1AppointmentsRouter };
