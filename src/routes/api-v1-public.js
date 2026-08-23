// Unauthenticated, patient-facing booking API — mounted at /api/v1/public in
// app.js, BEFORE the firebaseAuth-gated /api/v1 router so these routes never
// pass through staff auth. This is what makes schedurx-form-agent a thin
// client of this backend instead of its own separate Prisma-backed service:
// every route here wraps an existing, already-tested service function (no
// new booking/scheduling logic), and a booking made through POST /appointments
// fires the exact same booking_confirmed WhatsApp workflow every other
// booking path already triggers.
//
// Capability model: an appointment is addressed by its unguessable id PLUS
// its clinicId (same pattern as the team-invite tokens) — there is no
// separate patient login, so possession of the link is what authorizes
// viewing/rescheduling/cancelling it. clinicId always comes from the request
// itself here (unlike /api/v1/*, which takes it from req.staff) since there
// is no session to read it from.

const { Router } = require("express");
const { ok, fail } = require("../lib/response-envelope");
const { createRateLimiter } = require("../middleware/rate-limit");
const tableSvc = require("../services/table-service");
const clinicSvc = require("../services/clinic-service");
const appointmentSvc = require("../services/appointment-service");
const availabilitySvc = require("../services/availability-service");
const stripeSvc = require("../services/stripe-service");
const commsWorkflowSvc = require("../services/comms-workflow-service");
const { config } = require("../config");
const { normalizeIndianMobile } = require("../lib/phone");

// Ported from schedurx-form-agent's own POST /api/intake, which validated
// phone numbers the same way before writing to its now-retired Prisma
// Patient table — 10-digit Indian mobile numbers, optionally prefixed with
// +91, 91, or a leading 0. The prefix strip only fires when the digit count
// implies an actual prefix (12 digits for "91...", 11 for a leading "0") —
// stripping unconditionally breaks a bare 10-digit number that happens to
// start with "91" (e.g. 9123456780), which is a valid number in its own right.
const normalizePhone = normalizeIndianMobile;

function publicClinicView(clinic, doctors) {
  const rules = clinicSvc.getSchedulingRules(clinic);
  return {
    id: clinic.id,
    name: clinic.name,
    phone: clinic.phone ?? null,
    timezone: rules.timezone,
    doctors: doctors.map((d) => ({
      id: d.id,
      fullName: d.fullName,
      specialty: d.specialty,
      qualification: d.qualification,
      bio: d.bio,
      languages: d.languages,
      feeInr: d.feeInr,
    })),
  };
}

function createApiV1PublicRouter(supabaseClient, nettuClient, twilioClient, stripeClient) {
  const router = Router();
  const limiter = createRateLimiter({ windowMs: 60_000, max: 10 });
  router.use(limiter);

  // GET /api/v1/public/clinic/:clinicId — doctor roster + booking-relevant
  // clinic info only, stripped of anything internal (no settings, no scheduler ids).
  router.get("/clinic/:clinicId", async (req, res) => {
    try {
      const clinic = await clinicSvc.getClinic(supabaseClient, req.params.clinicId);
      if (!clinic || (clinic.status && clinic.status !== "active")) {
        return fail(res, 404, "CLINIC_NOT_FOUND", "Clinic not found");
      }
      const doctors = await tableSvc.listActiveDoctors(supabaseClient, clinic.id);
      return ok(res, publicClinicView(clinic, doctors));
    } catch (err) {
      req.log?.error({ err }, "[api-v1:public] get clinic failed");
      return fail(res, err.statusCode ?? 500, err.code ?? "INTERNAL_ERROR", err.message);
    }
  });

  // GET /api/v1/public/slots?clinicId=&doctorId=&date=
  router.get("/slots", async (req, res) => {
    if (!nettuClient) return fail(res, 503, "SCHEDULER_NOT_CONFIGURED", "Calendar scheduling is not configured");

    const { clinicId, doctorId, date } = req.query;
    if (!clinicId || !doctorId) {
      return fail(res, 422, "MISSING_FIELDS", "clinicId and doctorId are required");
    }
    try {
      const result = await availabilitySvc.getAvailableSlots(
        nettuClient,
        supabaseClient,
        { clinicId, doctorId, date },
        req.log,
      );
      return ok(res, result);
    } catch (err) {
      req.log?.error({ err }, "[api-v1:public] get slots failed");
      return fail(res, err.statusCode ?? 500, err.code ?? "INTERNAL_ERROR", err.message);
    }
  });

  // POST /api/v1/public/appointments — the real booking call. Resolves the
  // patient server-side via findOrCreatePatient; never trusts a client-supplied
  // patientId, matching every other patient-facing entry point in this codebase.
  router.post("/appointments", async (req, res) => {
    if (!nettuClient) return fail(res, 503, "SCHEDULER_NOT_CONFIGURED", "Calendar scheduling is not configured");

    const { clinicId, doctorId, start, end, patient, reason, notes, bookerRelation, proxyName, successUrl, cancelUrl } = req.body ?? {};
    if (!clinicId || !doctorId || !start || !patient?.phone) {
      return fail(res, 422, "MISSING_FIELDS", "clinicId, doctorId, start, and patient.phone are required");
    }
    const phone = normalizePhone(patient.phone);
    if (!phone) return fail(res, 422, "INVALID_PHONE", "patient.phone must be a valid 10-digit Indian mobile number");

    try {
      const patientRow = await tableSvc.findOrCreatePatient(supabaseClient, clinicId, {
        phone,
        fullName: patient.fullName,
        age: patient.age,
        gender: patient.gender,
      });

      // Pay-first token payments (Phase 3): whether a token is required is
      // the clinic's own configured policy (Clinic.tokenMoneyEnabled/
      // tokenAmountPaise, set in clinic settings) — never a client-supplied
      // flag, so a patient can't just omit it to skip payment.
      const clinic = await clinicSvc.getClinic(supabaseClient, clinicId);
      if (clinic?.tokenMoneyEnabled && clinic?.tokenAmountPaise) {
        if (!stripeClient) return fail(res, 503, "STRIPE_NOT_CONFIGURED", "This clinic requires a token payment, but billing isn't set up yet — please call the clinic to book");

        // schedurx-form-agent (a separate repo) can pass its own thank-you/
        // cancel page URLs; falls back to this backend's own confirmation
        // page (built for exactly this — see GET /appointments/:id below) so
        // booking still works end-to-end before that repo is updated to pass
        // them explicitly.
        const fallbackBase = config.PATIENT_APP_BASE_URL ? `${config.PATIENT_APP_BASE_URL}/${clinicId}` : null;
        const finalSuccessUrl = successUrl ?? (fallbackBase ? `${fallbackBase}/pending?paid=1` : null);
        const finalCancelUrl = cancelUrl ?? (fallbackBase ? `${fallbackBase}/pending?paid=0` : null);
        if (!finalSuccessUrl || !finalCancelUrl) {
          return fail(res, 422, "MISSING_FIELDS", "successUrl and cancelUrl are required (PATIENT_APP_BASE_URL is not configured as a fallback)");
        }

        const pending = await appointmentSvc.createPendingTokenBooking(
          nettuClient,
          supabaseClient,
          {
            clinicId,
            doctorId,
            patientId: patientRow.id,
            start,
            end,
            patient: { name: patientRow.fullName, phone: patientRow.contactNumber },
            reason,
            notes,
            bookerRelation,
            proxyName,
            source: "patient_web",
          },
          req.log,
          twilioClient,
        );

        const session = await stripeSvc.createTokenCheckoutSession(stripeClient, {
          pendingBookingId: pending.pendingBookingId,
          amountPaise: pending.amountPaise,
          clinicId,
          clinicName: clinic.name,
          successUrl: finalSuccessUrl,
          cancelUrl: finalCancelUrl,
        });

        return ok(res, {
          pendingBookingId: pending.pendingBookingId,
          checkoutUrl: session.url,
          amountPaise: pending.amountPaise,
          patient: patientRow,
        });
      }

      const appointment = await appointmentSvc.bookAppointment(
        nettuClient,
        supabaseClient,
        {
          clinicId,
          doctorId,
          patientId: patientRow.id,
          start,
          end,
          patient: { name: patientRow.fullName, phone: patientRow.contactNumber },
          reason,
          notes,
          bookerRelation,
          proxyName,
          source: "patient_web",
        },
        req.log,
        twilioClient,
      );

      return res.status(201).json({ success: true, data: { appointment, patient: patientRow }, message: null });
    } catch (err) {
      req.log?.error({ err }, "[api-v1:public] book appointment failed");
      return fail(res, err.statusCode ?? 500, err.code ?? "INTERNAL_ERROR", err.message);
    }
  });

  // GET /api/v1/public/appointments/:id?clinicId= — the confirmation/manage
  // page. Both ids are required together (capability model, see file header).
  router.get("/appointments/:id", async (req, res) => {
    const { clinicId } = req.query;
    if (!clinicId) return fail(res, 422, "MISSING_FIELDS", "clinicId is required");

    try {
      const clinic = await clinicSvc.getClinic(supabaseClient, clinicId);
      if (!clinic) return fail(res, 404, "CLINIC_NOT_FOUND", "Clinic not found");

      const appt = await tableSvc.getAppointmentById(supabaseClient, clinicId, req.params.id);
      if (!appt) return fail(res, 404, "APPOINTMENT_NOT_FOUND", "Appointment not found");

      const [patient, doctors] = await Promise.all([
        appt.patientId ? tableSvc.getPatientById(supabaseClient, clinicId, appt.patientId) : null,
        tableSvc.listActiveDoctors(supabaseClient, clinicId),
      ]);
      const doctor = doctors.find((d) => d.id === appt.doctorId) ?? null;

      return ok(res, {
        appointment: appt,
        patient: patient ? { fullName: patient.fullName, contactNumber: patient.contactNumber } : null,
        doctor: doctor ? { id: doctor.id, fullName: doctor.fullName, specialty: doctor.specialty } : null,
        clinic: { id: clinic.id, name: clinic.name, phone: clinic.phone ?? null },
      });
    } catch (err) {
      req.log?.error({ err }, "[api-v1:public] get appointment failed");
      return fail(res, err.statusCode ?? 500, err.code ?? "INTERNAL_ERROR", err.message);
    }
  });

  // GET /api/v1/public/appointments/:id/comms-links?clinicId= — the minimal
  // contract for schedurx-form-agent's thank-you page CTAs (Phase 7):
  // reviewUrl (Clinic.googleReviewUrl, null if the clinic hasn't set one)
  // and textCommsUrl (a wa.me deep link straight into this booking's own
  // Thread — see webhooks-twilio.js's BOOKING deep-link fast path). Same
  // capability model as the confirmation route above (id + clinicId
  // together); doesn't require Twilio to be configured (returns
  // textCommsUrl: null instead of a link nobody could open).
  router.get("/appointments/:id/comms-links", async (req, res) => {
    const { clinicId } = req.query;
    if (!clinicId) return fail(res, 422, "MISSING_FIELDS", "clinicId is required");

    try {
      const clinic = await clinicSvc.getClinic(supabaseClient, clinicId);
      if (!clinic) return fail(res, 404, "CLINIC_NOT_FOUND", "Clinic not found");

      const appt = await tableSvc.getAppointmentById(supabaseClient, clinicId, req.params.id);
      if (!appt) return fail(res, 404, "APPOINTMENT_NOT_FOUND", "Appointment not found");

      return ok(res, {
        reviewUrl: clinic.googleReviewUrl ?? null,
        textCommsUrl: commsWorkflowSvc.buildTextCommsUrl(clinic, appt.id),
      });
    } catch (err) {
      req.log?.error({ err }, "[api-v1:public] get comms-links failed");
      return fail(res, err.statusCode ?? 500, err.code ?? "INTERNAL_ERROR", err.message);
    }
  });

  // PATCH /api/v1/public/appointments/:id — reschedule. doctorId defaults to
  // the appointment's existing doctor so the patient-facing UI only has to
  // resubmit a new slot, not re-pick a doctor.
  router.patch("/appointments/:id", async (req, res) => {
    if (!nettuClient) return fail(res, 503, "SCHEDULER_NOT_CONFIGURED", "Calendar scheduling is not configured");

    const { clinicId, doctorId, newStart, newEnd, reason } = req.body ?? {};
    if (!clinicId || !newStart) return fail(res, 422, "MISSING_FIELDS", "clinicId and newStart are required");

    try {
      const existing = await tableSvc.getAppointmentById(supabaseClient, clinicId, req.params.id);
      if (!existing) return fail(res, 404, "APPOINTMENT_NOT_FOUND", "Appointment not found");

      const result = await appointmentSvc.rescheduleAppointment(
        nettuClient,
        supabaseClient,
        {
          appointmentId: req.params.id,
          clinicId,
          doctorId: doctorId ?? existing.doctorId,
          newStart,
          newEnd,
          reason,
          source: "patient_web",
        },
        req.log,
        twilioClient,
      );
      return ok(res, result);
    } catch (err) {
      req.log?.error({ err }, "[api-v1:public] reschedule appointment failed");
      return fail(res, err.statusCode ?? 500, err.code ?? "INTERNAL_ERROR", err.message);
    }
  });

  // DELETE /api/v1/public/appointments/:id — cancel. clinicId comes in the
  // body since DELETE requests from a browser fetch() carry one just fine,
  // and every other field on this router already reads from req.body.
  router.delete("/appointments/:id", async (req, res) => {
    if (!nettuClient) return fail(res, 503, "SCHEDULER_NOT_CONFIGURED", "Calendar scheduling is not configured");

    const { clinicId, reason } = req.body ?? {};
    if (!clinicId) return fail(res, 422, "MISSING_FIELDS", "clinicId is required");

    try {
      const result = await appointmentSvc.cancelAppointment(
        nettuClient,
        supabaseClient,
        { appointmentId: req.params.id, clinicId, reason, source: "patient_web" },
        req.log,
        twilioClient,
      );
      return ok(res, result);
    } catch (err) {
      req.log?.error({ err }, "[api-v1:public] cancel appointment failed");
      return fail(res, err.statusCode ?? 500, err.code ?? "INTERNAL_ERROR", err.message);
    }
  });

  return router;
}

module.exports = { createApiV1PublicRouter, normalizePhone };
