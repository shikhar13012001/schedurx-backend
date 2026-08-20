const { Router } = require("express");
const { resolveCallCtx, formUrl } = require("./tool-helpers");
const { ok, fail, fetchAlternatives } = require("./calendar-tool-helpers");
const { bookAppointment } = require("../services/appointment-service");

function createAppointmentsRouter(nettuClient, supabaseClient, callStore, twilioClient) {
  const router = Router();

  // POST /tools/appointments/book
  // Calendar-integrated booking: creates a nettu-scheduler event + Supabase record atomically.
  // Requires select_doctor to have been called first (doctorId resolved from context).
  // Requires slotStart from get_doctor_available_slots (no guessing slot times).
  router.post("/book", async (req, res) => {
    req.log.info({ body: req.body }, "[tool] book_appointment invoked");

    const { ultravoxCallId, slotStart, slotEnd, appointmentType, reason } = req.body ?? {};

    const ctx = resolveCallCtx(callStore, ultravoxCallId, req.log);
    const clinicId = ctx?.clinicId ?? null;
    const doctorId = ctx?.doctorId ?? null;
    const patientId = ctx?.patientId ?? null;

    if (!clinicId) {
      return fail(res, 422, "CLINIC_NOT_FOUND", "clinicId could not be resolved — call identify_patient first");
    }
    if (!doctorId) {
      return fail(res, 422, "DOCTOR_NOT_SELECTED", "No doctor selected — call select_doctor first");
    }
    if (!slotStart) {
      return fail(
        res,
        422,
        "VALIDATION_ERROR",
        "slotStart is required — call get_doctor_available_slots first and use an exact returned slot",
      );
    }

    let result;
    try {
      result = await bookAppointment(
        nettuClient,
        supabaseClient,
        {
          clinicId,
          patientId,
          doctorId,
          start: slotStart,
          end: slotEnd ?? null,
          patient: { name: null, phone: ctx?.phoneNumber ?? null },
          appointmentType: appointmentType ?? "consultation",
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
          { clinicId, doctorId, fromIso: slotStart },
          req.log,
        );
        return fail(res, 409, "SLOT_NOT_AVAILABLE", "The selected slot is no longer available", {
          alternatives,
          suggestion:
            alternatives.length > 0
              ? `${alternatives.length} alternative slot(s) available — present these to the patient`
              : "No alternatives found in the next 7 days — ask the patient to try a different week",
        });
      }
      req.log.warn({ err, clinicId, doctorId }, "[tool] book_appointment failed");
      return fail(res, err.statusCode ?? 500, err.code ?? "SCHEDULER_API_ERROR", err.message);
    }

    const appointmentFormUrl = formUrl(result.clinicId, result.appointmentId);

    if (ultravoxCallId) {
      callStore?.upsert(ultravoxCallId, {
        appointment: {
          appointmentId: result.appointmentId,
          doctorId: result.doctorId,
          timeslot: result.start,
          status: result.status,
          formUrl: appointmentFormUrl,
        },
      });
    }

    req.log.info(
      { appointmentId: result.appointmentId, clinicId, doctorId, start: result.start, formUrl: appointmentFormUrl },
      "[tool] appointment booked",
    );

    return res.status(201).json({
      success: true,
      data: { appointment: { ...result, formUrl: appointmentFormUrl } },
      message: `Appointment booked for ${result.start}`,
    });
  });

  // POST /tools/appointments/send-form
  // Placeholder for SMS delivery — logs the form URL until messaging is configured.
  router.post("/send-form", async (req, res) => {
    req.log.info({ body: req.body }, "[tool] send_form invoked");
    const { ultravoxCallId } = req.body ?? {};

    const ctx = resolveCallCtx(callStore, ultravoxCallId, req.log);
    const appointmentFormUrl = ctx?.appointment?.formUrl ?? null;
    const phoneNumber = ctx?.phoneNumber ?? null;

    if (!appointmentFormUrl) {
      return res.status(422).json({ error: "No booked appointment found in this call — book an appointment first" });
    }

    req.log.info(
      { phoneNumber, formUrl: appointmentFormUrl },
      "[form] SMS not configured — form URL logged for manual delivery",
    );

    return res.json({
      delivered: false,
      note: "Form URL has been logged. SMS delivery will be available once messaging is configured.",
      formUrl: appointmentFormUrl,
    });
  });

  return router;
}

module.exports = { createAppointmentsRouter };
