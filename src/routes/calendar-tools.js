// Thin route handlers for the four calendar-based Ultravox tools.
//
// Flow assumptions:
//   1. identify_patient  → resolves clinicId into call context
//   2. select_doctor     → resolves doctorId + schedulerDoctorId + schedulerCalendarId into call context
//   3. get_doctor_available_slots / book / reschedule / cancel — read IDs from context only
//
// Agents must NEVER pass doctorId, calendarId, or clinicId in the request body.
// The only required context key from the request is ultravoxCallId.

const { Router } = require("express");
const { resolveCallCtx } = require("./tool-helpers");
const availabilitySvc = require("../services/availability-service");
const { rescheduleAppointment, cancelAppointment } = require("../services/appointment-service");
const { ok, fail, isValidTimezone, fetchAlternatives } = require("./calendar-tool-helpers");

// ─── Router factory ───────────────────────────────────────────────────────────

function createCalendarToolsRouter(nettuClient, supabaseClient, callStore, twilioClient) {
  const router = Router();

  // ── GET available slots ──────────────────────────────────────────────────
  // POST /tools/calendar/slots
  router.post("/slots", async (req, res) => {
    req.log.info({ body: req.body }, "[tool] get_doctor_available_slots invoked");

    const { ultravoxCallId, date, dateRange, timezone } = req.body ?? {};

    const ctx = resolveCallCtx(callStore, ultravoxCallId, req.log);
    const clinicId = ctx?.clinicId ?? null;
    const doctorId = ctx?.doctorId ?? null;

    if (!clinicId) {
      return fail(res, 422, "CLINIC_NOT_FOUND", "clinicId could not be resolved — call identify_patient first");
    }
    if (!doctorId) {
      return fail(
        res,
        422,
        "DOCTOR_NOT_SELECTED",
        "No doctor selected — call select_doctor with the patient's preferred doctor first",
      );
    }
    if (timezone && !isValidTimezone(timezone)) {
      return fail(res, 400, "INVALID_TIMEZONE", `'${timezone}' is not a valid IANA timezone`);
    }

    let result;
    try {
      result = await availabilitySvc.getAvailableSlots(
        nettuClient,
        supabaseClient,
        { clinicId, doctorId, date, dateRange, timezone },
        req.log,
      );
    } catch (err) {
      req.log.warn({ err, clinicId, doctorId }, "[tool] get_doctor_available_slots failed");
      return fail(res, err.statusCode ?? 500, err.code ?? "SCHEDULER_API_ERROR", err.message);
    }

    if (result.slots.length === 0) {
      return fail(
        res,
        200,
        "NO_SLOTS_AVAILABLE",
        "No available slots found for the requested period — try a different date range",
        { startDate: result.startDate, endDate: result.endDate, timezone: result.timezone },
      );
    }

    return ok(
      res,
      {
        clinicId,
        doctorId,
        timezone: result.timezone,
        startDate: result.startDate,
        endDate: result.endDate,
        slots: result.slots,
      },
      `Found ${result.slots.length} available slot(s)`,
    );
  });

  // ── Reschedule appointment ───────────────────────────────────────────────
  // POST /tools/calendar/reschedule
  router.post("/reschedule", async (req, res) => {
    req.log.info({ body: req.body }, "[tool] reschedule_appointment invoked");

    const { ultravoxCallId, appointmentId: bodyApptId, newStart, newEnd, reason } = req.body ?? {};

    const ctx = resolveCallCtx(callStore, ultravoxCallId, req.log);
    const clinicId = ctx?.clinicId ?? null;
    const doctorId = ctx?.doctorId ?? ctx?.appointment?.doctorId ?? null;
    const appointmentId = bodyApptId ?? ctx?.appointment?.appointmentId ?? null;

    if (!appointmentId) return fail(res, 422, "VALIDATION_ERROR", "appointmentId is required");
    if (!newStart) return fail(res, 422, "VALIDATION_ERROR", "newStart is required");
    if (!clinicId)
      return fail(res, 422, "CLINIC_NOT_FOUND", "clinicId could not be resolved — call identify_patient first");
    if (!doctorId)
      return fail(res, 422, "DOCTOR_NOT_SELECTED", "doctorId could not be resolved — call select_doctor first");

    let result;
    try {
      result = await rescheduleAppointment(
        nettuClient,
        supabaseClient,
        {
          appointmentId,
          clinicId,
          doctorId,
          newStart,
          newEnd: newEnd ?? null,
          reason: reason ?? null,
          source: "ultravox",
        },
        req.log,
        twilioClient,
      );
    } catch (err) {
      if (err.code === "SLOT_NOT_AVAILABLE") {
        const alternatives = await fetchAlternatives(
          nettuClient,
          supabaseClient,
          { clinicId, doctorId, fromIso: newStart },
          req.log,
        );
        return fail(res, 409, "SLOT_NOT_AVAILABLE", "The new slot is no longer available", {
          alternatives,
          suggestion:
            alternatives.length > 0
              ? `${alternatives.length} alternative slot(s) available`
              : "No alternatives found in the next 7 days",
        });
      }
      req.log.warn({ err, appointmentId }, "[tool] reschedule_appointment failed");
      return fail(res, err.statusCode ?? 500, err.code ?? "SCHEDULER_API_ERROR", err.message);
    }

    if (ultravoxCallId) {
      callStore?.upsert(ultravoxCallId, {
        appointment: { ...ctx?.appointment, timeslot: result.newStart, status: result.status },
      });
    }

    return ok(res, { appointment: result }, `Appointment rescheduled to ${result.newStart}`);
  });

  // ── Cancel appointment ───────────────────────────────────────────────────
  // POST /tools/calendar/cancel
  router.post("/cancel", async (req, res) => {
    req.log.info({ body: req.body }, "[tool] cancel_appointment invoked");

    const { ultravoxCallId, appointmentId: bodyApptId, reason } = req.body ?? {};

    const ctx = resolveCallCtx(callStore, ultravoxCallId, req.log);
    const clinicId = ctx?.clinicId ?? null;
    const appointmentId = bodyApptId ?? ctx?.appointment?.appointmentId ?? null;

    if (!appointmentId) return fail(res, 422, "VALIDATION_ERROR", "appointmentId is required");
    if (!clinicId)
      return fail(res, 422, "CLINIC_NOT_FOUND", "clinicId could not be resolved — call identify_patient first");

    let result;
    try {
      result = await cancelAppointment(
        nettuClient,
        supabaseClient,
        { appointmentId, clinicId, reason: reason ?? null, source: "ultravox" },
        req.log,
        twilioClient,
      );
    } catch (err) {
      req.log.warn({ err, appointmentId }, "[tool] cancel_appointment failed");
      return fail(res, err.statusCode ?? 500, err.code ?? "SCHEDULER_API_ERROR", err.message);
    }

    if (ultravoxCallId) {
      callStore?.upsert(ultravoxCallId, {
        appointment: { ...ctx?.appointment, status: "cancelled" },
      });
    }

    return ok(res, { appointment: result }, "Appointment cancelled");
  });

  return router;
}

module.exports = { createCalendarToolsRouter };
