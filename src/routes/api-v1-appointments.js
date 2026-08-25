const { Router } = require("express");
const { ok, fail } = require("../lib/response-envelope");
const tableSvc = require("../services/table-service");
const appointmentSvc = require("../services/appointment-service");
const availabilitySvc = require("../services/availability-service");
const clinicSvc = require("../services/clinic-service");
const stripeSvc = require("../services/stripe-service");
const failedMessageSvc = require("../services/failed-message-service");
const { config } = require("../config");

// GET /api/v1/appointments?date=YYYY-MM-DD&doctorId=... — clinicId always comes
// from req.staff (set by firebaseAuth), never from the query string.
// POST /api/v1/appointments — dashboard booking (reuses the same bookAppointment()
// the voice-agent tool uses, so nettu-scheduler conflict detection/booking-window
// rules apply identically regardless of who's booking).
function createApiV1AppointmentsRouter(supabaseClient, nettuClient, twilioClient, stripeClient) {
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

      // Pay-first token booking (Phase 3): reserve the slot + hold the
      // booking details, and only write the real Appointment once
      // stripe-webhook.js confirms payment — no Appointment (and no
      // "booking confirmed" message) exists yet. It's the PATIENT who pays,
      // not the receptionist sitting at this dashboard — the checkout link
      // is sent to the patient's own WhatsApp, matching the UI copy this
      // toggle has always shown ("payment link on WhatsApp"), never a
      // browser redirect for the staff member submitting this form.
      if (tokenRequested) {
        if (!stripeClient) return fail(res, 503, "STRIPE_NOT_CONFIGURED", "STRIPE_SECRET_KEY is not set");

        const pending = await appointmentSvc.createPendingTokenBooking(
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
            source: "reception",
          },
          req.log,
          twilioClient,
        );

        const clinic = await clinicSvc.getClinic(supabaseClient, req.staff.clinicId);
        // Prefer schedurx-form-agent's own payment page (not straight to
        // Stripe) — that page creates a fresh Checkout Session on demand
        // (see api-v1-public.js's POST /pending-bookings/:id/checkout-session),
        // so the link stays valid even if the patient opens it well after
        // this message was sent, and shows real booking details before
        // handing off to Stripe. Falls back to a Stripe session created
        // right now if PATIENT_APP_BASE_URL isn't configured — same
        // graceful-degrade posture as bookingUrlFor, but this feature still
        // needs to work end-to-end even then, unlike a booking confirmation
        // that can just omit a nice-to-have link.
        const payUrl = config.PATIENT_APP_BASE_URL
          ? `${config.PATIENT_APP_BASE_URL}/${req.staff.clinicId}/pay/${pending.pendingBookingId}`
          : (
              await stripeSvc.createTokenCheckoutSession(stripeClient, {
                pendingBookingId: pending.pendingBookingId,
                amountPaise: pending.amountPaise,
                clinicId: req.staff.clinicId,
                clinicName: clinic?.name,
                successUrl: "https://schedurx.com/booked",
                cancelUrl: "https://schedurx.com/booked",
              })
            ).url;
        const messageBody = `Hi ${patientRow.fullName || "there"}, please complete your ₹${Math.round(pending.amountPaise / 100)} booking payment to confirm your appointment at ${clinic?.name ?? "the clinic"}: ${payUrl}`;

        // SMS has no session-window restriction (unlike free-form WhatsApp,
        // which Meta blocks outside an open 24h conversation — true for
        // almost every brand-new booking) — send it unconditionally so the
        // patient reliably gets the link even when WhatsApp can't deliver.
        let smsSent = false;
        if (twilioClient && patientRow.contactNumber) {
          try {
            await twilioClient.sendSms({ to: patientRow.contactNumber, body: messageBody, clinicId: req.staff.clinicId, purpose: "token_payment" });
            smsSent = true;
          } catch (err) {
            req.log?.warn({ err, pendingBookingId: pending.pendingBookingId }, "[api-v1:appointments] token payment SMS failed to send");
            await failedMessageSvc.enqueue(
              supabaseClient,
              { clinicId: req.staff.clinicId, channel: "sms", toPhone: patientRow.contactNumber, body: messageBody, purpose: "token_payment", error: err },
              req.log,
            );
          }
        }

        let tokenLinkSent = false;
        if (twilioClient && patientRow.contactNumber) {
          try {
            await twilioClient.sendWhatsApp({ to: patientRow.contactNumber, body: messageBody, clinicId: req.staff.clinicId, purpose: "token_payment" });
            tokenLinkSent = true;
          } catch (err) {
            // Free-text WhatsApp only delivers inside an open 24h session
            // window (see comms-workflow-service.js) — no approved Content
            // Template exists yet for an ad-hoc payment link, so this can
            // legitimately fail (routinely, not rarely — that specific
            // failure is terminal and enqueue() won't queue it; see
            // failed-message-service.js's isRetryableError). The SMS above
            // and checkoutUrl below both still get the patient/staff a
            // working link regardless.
            req.log?.warn({ err, pendingBookingId: pending.pendingBookingId }, "[api-v1:appointments] token payment WhatsApp link failed to send");
            await failedMessageSvc.enqueue(
              supabaseClient,
              { clinicId: req.staff.clinicId, channel: "whatsapp", toPhone: patientRow.contactNumber, body: messageBody, purpose: "token_payment", error: err },
              req.log,
            );
          }
        }

        return ok(res, {
          pendingBookingId: pending.pendingBookingId,
          checkoutUrl: payUrl,
          amountPaise: pending.amountPaise,
          tokenLinkSent,
          smsSent,
          patient: patientRow,
        });
      }

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
