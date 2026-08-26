// Calendar-integrated appointment booking, rescheduling, and cancellation.
// Creates and manages nettu-scheduler events alongside Supabase appointment records.

const crypto = require("node:crypto");
const clinicSvc = require("./clinic-service");
const doctorSvc = require("./doctor-service");
const { epochToISO, formatHumanTime, toDateString } = require("./availability-service");
const commsWorkflowSvc = require("./comms-workflow-service");
const visitSvc = require("./visit-service");
const { config } = require("../config");

// Same relative-path shape as routes/tool-helpers.js's formUrl() (used by the
// voice-agent's /tools/appointments/send-form) — kept here rather than
// imported from a routes/ file to avoid a services→routes dependency, since
// it's one line either way.
function bookingUrlFor(clinicId, appointmentId) {
  return config.PATIENT_APP_BASE_URL ? `${config.PATIENT_APP_BASE_URL}/${clinicId}/${appointmentId}` : undefined;
}

const SAFE_TITLE_PREFIX = "Appointment";

// How long before an event's start nettu-scheduler calls our reminder
// webhook (POST /webhooks/nettu-reminders) — see that route for what happens
// on receipt. Not yet a per-clinic setting; one default for every booking
// and block.
const REMINDER_MINUTES_BEFORE = 15;

// Build a privacy-safe calendar event title.
function eventTitle(doctorName) {
  return `${SAFE_TITLE_PREFIX}${doctorName ? ` - ${doctorName}` : ""}`;
}

// Parse an ISO 8601 string to epoch milliseconds. Throws INVALID_DATE on failure.
function isoToEpochMs(iso) {
  const ms = new Date(iso).getTime();
  if (isNaN(ms)) {
    throw Object.assign(new Error(`Invalid ISO date: '${iso}'`), { code: "INVALID_DATE", statusCode: 400 });
  }
  return ms;
}

// Append an entry to the appointment's auditHistory JSONB array.
function buildAuditEntry(action, { actor, reason, oldStart, newStart, oldEnd, newEnd }) {
  return {
    action,
    actor: actor ?? "system",
    reason: reason ?? null,
    oldStart: oldStart ?? null,
    oldEnd: oldEnd ?? null,
    newStart: newStart ?? null,
    newEnd: newEnd ?? null,
    timestamp: new Date().toISOString(),
  };
}

// ─── Book ─────────────────────────────────────────────────────────────────────

// opts: { clinicId, doctorId, start, end?, patient: { name, phone, email? },
//         appointmentType?, reason?, source?, bookerRelation?, proxyName?, notes? }
// twilioClient is optional (trailing) — omit it and this behaves exactly as
// before (no patient-facing messaging), matching every other integration's
// "absent client → feature quietly no-ops" convention in this codebase.
//
// Split into validateAndReserveSlot (Phase 3: everything up to and including
// the nettu-scheduler busy event — the part a pay-first token booking must
// do immediately, before payment, so nobody else can take the slot while a
// patient is on Stripe's checkout page) and persistAppointment (the Postgres
// write + patient-facing comms, done once a booking is actually confirmed —
// immediately for a normal booking, or later via finalizePendingBooking once
// Stripe confirms). bookAppointment itself is now just those two in
// sequence, unchanged in behavior for every existing caller.
async function validateAndReserveSlot(nettuClient, supabaseClient, opts, log, twilioClient) {
  const {
    clinicId,
    doctorId,
    start,
    end,
    reason,
    source = "system",
    status = "booked",
    mode = "clinic",
  } = opts;

  if (!["clinic", "video", "audio", "text"].includes(mode)) {
    throw Object.assign(new Error(`Invalid mode '${mode}'`), { code: "INVALID_MODE", statusCode: 422 });
  }

  const clinic = await clinicSvc.requireActiveClinic(supabaseClient, clinicId);
  const doctor = await doctorSvc.requireActiveDoctor(supabaseClient, doctorId, clinicId);
  const clinicRules = clinicSvc.getSchedulingRules(clinic);
  const doctorRules = doctorSvc.getSchedulingRules(doctor, clinicRules);
  const timezone = doctorRules.timezone;

  if (!clinic.schedulerServiceId) {
    throw Object.assign(new Error("Clinic calendar is not configured — run the setup script first"), {
      code: "SCHEDULER_API_ERROR",
      statusCode: 500,
    });
  }

  const startMs = isoToEpochMs(start);
  const endMs = end ? isoToEpochMs(end) : startMs + doctorRules.slotDurationMins * 60 * 1000;

  if (startMs <= Date.now()) {
    throw Object.assign(new Error("Slot start time is in the past"), { code: "SLOT_NOT_AVAILABLE", statusCode: 422 });
  }

  // Check booking window compliance.
  const maxBookingMs = Date.now() + clinicRules.maxBookingWindowDays * 24 * 60 * 60 * 1000;
  if (startMs > maxBookingMs) {
    throw Object.assign(new Error(`Slot is outside the ${clinicRules.maxBookingWindowDays}-day booking window`), {
      code: "OUTSIDE_BOOKING_WINDOW",
      statusCode: 422,
    });
  }

  log?.info({ clinicId, doctorId, start, source }, "[appointmentSvc] booking appointment");

  const durationMs = endMs - startMs;
  const isBlocked = status === "blocked";

  // A block is a deliberate doctor override, not something that should
  // silently coexist with a real booking already sitting in that window (the
  // nettu busy-event conflict check below only guards against two blocks
  // racing each other, not against pre-existing patient appointments — those
  // just sat there, unnotified, alongside the new block). Cancel every
  // booked/tentative appointment the new block actually overlaps first, each
  // with the same patient-facing cancellation message a normal cancel sends
  // — bypassing the cancellation cutoff since this is staff-forced, not a
  // patient request close to their own appointment.
  if (isBlocked) {
    const { data: possiblyConflicting, error: conflictErr } = await supabaseClient
      .from("Appointment")
      .select("id, timeslot, durationMinutes")
      .eq("clinicId", clinicId)
      .eq("doctorId", doctorId)
      .in("status", ["booked", "tentative"])
      .gte("timeslot", new Date(startMs - 24 * 60 * 60 * 1000).toISOString())
      .lt("timeslot", new Date(endMs).toISOString());

    if (conflictErr) {
      log?.warn({ err: conflictErr, doctorId, clinicId }, "[appointmentSvc] couldn't check for conflicting appointments before blocking — proceeding without auto-cancel");
    } else {
      for (const conflict of possiblyConflicting ?? []) {
        const conflictStartMs = new Date(conflict.timeslot).getTime();
        const conflictEndMs = conflictStartMs + (conflict.durationMinutes ?? 30) * 60_000;
        if (conflictEndMs <= startMs || conflictStartMs >= endMs) continue; // fetched for margin, doesn't actually overlap
        try {
          await cancelAppointment(
            nettuClient,
            supabaseClient,
            { appointmentId: conflict.id, clinicId, reason: reason ?? "Doctor became unavailable at this time", source, bypassCutoff: true },
            log,
            twilioClient,
          );
        } catch (err) {
          log?.error({ err, appointmentId: conflict.id }, "[appointmentSvc] couldn't auto-cancel conflicting appointment before blocking");
        }
      }
    }
  }

  // Generated up front (not after the nettu call) so it can ride along in
  // the event's metadata — the reminder webhook only gets the CalendarEvent
  // back, not our own request context, so this is how it knows which
  // Appointment/Notification to create.
  const appointmentId = `apt_${crypto.randomUUID()}`;

  // Create a busy calendar event in nettu (marks slot as taken).
  // serviceId links the event to the clinic's service for conflict detection.
  // reminders: the staff -15min entry (bare appointmentId identifier) plus one
  // entry per the clinic's configured delayed comms workflows (composite
  // "<appointmentId>::<workflowId>" identifier) — see webhooks-nettu.js for
  // what happens on receipt of each. Blocked-time entries have no patient, so
  // they only ever get the staff entry, never workflow ones.
  const reminders = [
    { delta: -REMINDER_MINUTES_BEFORE, identifier: appointmentId },
    ...(isBlocked ? [] : commsWorkflowSvc.buildDelayedReminderEntries(clinic, appointmentId, startMs)),
  ];

  let nettuEvent;
  try {
    nettuEvent = await nettuClient.createEvent(doctor.schedulerDoctorId, {
      calendarId: doctor.schedulerCalendarId,
      startTs: startMs,
      durationMs,
      busy: true,
      serviceId: clinic.schedulerServiceId,
      metadata: {
        clinicId,
        appointmentId,
        doctorId,
        kind: isBlocked ? "blocked" : "appointment",
        appointmentSource: source,
      },
      reminders,
    });
  } catch (err) {
    if (err.httpStatus === 409) {
      throw Object.assign(new Error("The selected slot is no longer available"), {
        code: "SLOT_NOT_AVAILABLE",
        statusCode: 409,
      });
    }
    throw Object.assign(new Error(`Scheduler API error: ${err.message}`), {
      code: "SCHEDULER_API_ERROR",
      statusCode: 502,
    });
  }

  return {
    clinic,
    doctor,
    timezone,
    startMs,
    endMs,
    durationMs,
    isBlocked,
    appointmentId,
    nettuEvent,
  };
}

// Writes the Postgres Appointment row for an already-reserved slot and sends
// the booking-confirmed comms — the part that happens immediately for a
// normal booking, or later (via finalizePendingBooking) once Stripe confirms
// a pay-first token payment. opts here is the same shape bookAppointment
// always took; only the fields persistAppointment itself needs are read.
async function persistAppointment(nettuClient, supabaseClient, reservation, opts, log, twilioClient) {
  const { clinic, doctor, timezone, startMs, endMs, durationMs, isBlocked, appointmentId, nettuEvent } = reservation;
  const {
    patientId,
    patient,
    reason,
    notes,
    source = "system",
    bookerRelation = "self",
    proxyName,
    status = "booked",
    mode = "clinic",
    tokenRequested = false,
  } = opts;

  const now = new Date().toISOString();
  const auditEntry = buildAuditEntry("created", { actor: source, reason });

  const { data: appointment, error } = await supabaseClient
    .from("Appointment")
    .insert({
      id: appointmentId,
      clinicId: clinic.id,
      patientId: patientId ?? null,
      doctorId: doctor.id,
      // A genuine UTC instant, not the raw client string — `timeslot` is a
      // legacy `timestamp without time zone` column (see lib/dates.js), and
      // Postgres silently DISCARDS an offset like "+05:30" on write to such
      // a column, keeping only the local wall-clock digits. The read-side
      // normalizer (toUtcIso) then stamps "Z" onto those digits assuming
      // they're already UTC — correct for the dashboard's own UTC-`Z`
      // bookings, but silently wrong for any offset-bearing caller (the
      // public booking API's slots are `epochToISO()`-formatted with a real
      // offset) — a real live bug, confirmed against a corrupted appointment
      // (stored local 14:45 IST re-read as if it meant UTC 14:45, displaying
      // as 20:15 IST). Converting through startMs here makes the digits
      // genuinely UTC regardless of what format the caller sent.
      timeslot: new Date(startMs).toISOString(),
      symptoms: reason ?? null,
      notes: notes ?? null,
      bookerRelation,
      proxyName: proxyName ?? null,
      durationMinutes: Math.round(durationMs / 60_000),
      status,
      mode,
      tokenRequested,
      schedulerEventId: nettuEvent?.id ?? null,
      source,
      auditHistory: [auditEntry],
      createdAt: now,
      updatedAt: now,
    })
    .select()
    .single();

  if (error) {
    // appointment_doctor_active_slot_idx (20260827_appointment_slot_uniqueness.sql)
    // is the real backstop against two concurrent bookings landing the same
    // doctor+timeslot — nettu's own conflict check only ever guarded the
    // slot-listing query, never the write, so two requests could both
    // create a busy event and both reach this insert (confirmed live). The
    // nettu event this reservation already created is now an orphaned hold
    // on the doctor's calendar for a booking that didn't actually win —
    // delete it so the slot doesn't stay falsely blocked.
    if (error.code === "23505") {
      log?.info(
        { appointmentId, nettuEventId: nettuEvent?.id, clinicId: clinic.id, doctorId: doctor.id },
        "[appointmentSvc] lost the race for this slot — releasing the now-orphaned nettu hold",
      );
      if (nettuEvent?.id && doctor.schedulerDoctorId) {
        try {
          await nettuClient.deleteEvent(doctor.schedulerDoctorId, nettuEvent.id);
        } catch (cleanupErr) {
          log?.warn(
            { err: cleanupErr, nettuEventId: nettuEvent.id },
            "[appointmentSvc] couldn't release orphaned nettu hold after losing a slot race — will show as busy until manually cleared",
          );
        }
      }
      throw Object.assign(new Error("The selected slot is no longer available"), {
        code: "SLOT_NOT_AVAILABLE",
        statusCode: 409,
      });
    }

    // DB failed after the nettu event was created — log for manual reconciliation.
    log?.error(
      { err: error, nettuEventId: nettuEvent?.id, clinicId: clinic.id, doctorId: doctor.id },
      "[appointmentSvc] DB insert failed after nettu event created — manual reconciliation needed",
    );
    throw Object.assign(new Error("Database error saving appointment"), { code: "DATABASE_ERROR", statusCode: 500 });
  }

  log?.info({ appointmentId, nettuEventId: nettuEvent?.id, doctorId: doctor.id, clinicId: clinic.id }, "[appointmentSvc] appointment booked");

  if (!isBlocked && patient?.phone) {
    await commsWorkflowSvc.sendImmediateWorkflowMessages(
      {
        supabaseClient,
        twilioClient,
        clinic,
        trigger: "booking_confirmed",
        appointmentId,
        toPhone: patient.phone,
        data: {
          clinicName: clinic.name,
          clinicPhone: clinic.phone,
          doctorName: doctor.fullName,
          patientName: patient.name,
          apptTime: formatHumanTime(startMs, timezone),
          bookingUrl: bookingUrlFor(clinic.id, appointmentId),
          // Suffix-only form of bookingUrl, for Content Template URL buttons —
          // Meta/Twilio only allow a variable at the end of an already-fixed
          // base URL on a button component, never the whole URL as one variable.
          bookingUrlPath: `${clinic.id}/${appointmentId}`,
        },
      },
      log,
    );
  }

  return {
    appointmentId: appointment.id,
    schedulerEventId: appointment.schedulerEventId,
    clinicId: appointment.clinicId,
    doctorId: appointment.doctorId,
    start: epochToISO(startMs, timezone),
    end: epochToISO(endMs, timezone),
    status: appointment.status,
    mode: appointment.mode,
    tokenRequested: appointment.tokenRequested,
    patient: { name: patient?.name ?? null, phone: patient?.phone ?? null },
    source: appointment.source,
  };
}

async function bookAppointment(nettuClient, supabaseClient, opts, log, twilioClient) {
  const reservation = await validateAndReserveSlot(nettuClient, supabaseClient, opts, log, twilioClient);
  return persistAppointment(nettuClient, supabaseClient, reservation, opts, log, twilioClient);
}

// ─── Pay-first token payments (Phase 3) ────────────────────────────────────

const PENDING_BOOKING_TTL_MINUTES = 20;

// Reserves the slot (a real nettu busy event — see validateAndReserveSlot)
// and parks the booking details in PendingBooking instead of writing an
// Appointment row. The caller (a route) is expected to build a Stripe
// Checkout Session with metadata.pendingBookingId = the returned id;
// finalizePendingBooking turns this into a real Appointment once Stripe
// confirms payment. Throws TOKEN_AMOUNT_NOT_CONFIGURED if the clinic has no
// tokenAmountPaise set — callers should only reach this function once
// they've confirmed a token is actually being requested.
async function createPendingTokenBooking(nettuClient, supabaseClient, opts, log, twilioClient) {
  const reservation = await validateAndReserveSlot(nettuClient, supabaseClient, opts, log, twilioClient);
  const { clinic, doctor, startMs, durationMs, appointmentId, nettuEvent } = reservation;

  const amountPaise = clinic.tokenAmountPaise;
  if (!amountPaise) {
    throw Object.assign(new Error(`Clinic '${clinic.id}' has no token amount configured`), {
      code: "TOKEN_AMOUNT_NOT_CONFIGURED",
      statusCode: 422,
    });
  }

  const {
    patientId,
    patient,
    appointmentType,
    reason,
    notes,
    source = "system",
    bookerRelation = "self",
    proxyName,
    mode = "clinic",
  } = opts;
  const bookingParams = { patientId, patient, appointmentType, reason, notes, source, bookerRelation, proxyName, mode };

  const now = new Date().toISOString();
  const { data, error } = await supabaseClient
    .from("PendingBooking")
    .insert({
      id: `pbk_${crypto.randomUUID()}`,
      clinicId: clinic.id,
      doctorId: doctor.id,
      appointmentId,
      schedulerEventId: nettuEvent?.id ?? null,
      timeslot: new Date(startMs).toISOString(),
      durationMinutes: Math.round(durationMs / 60_000),
      amountPaise,
      bookingParams,
      status: "pending",
      expiresAt: new Date(Date.now() + PENDING_BOOKING_TTL_MINUTES * 60_000).toISOString(),
      createdAt: now,
      updatedAt: now,
    })
    .select()
    .single();

  if (error) {
    // The nettu hold is already live at this point — left in place
    // deliberately rather than best-effort-deleted here: expirePendingBookings
    // can't clean up a row that was never written, but nettu's own event
    // will simply sit unclaimed until a human notices via reconciliation
    // logs, same "log for manual reconciliation" posture as persistAppointment's
    // DB-failure branch above.
    log?.error(
      { err: error, appointmentId, nettuEventId: nettuEvent?.id },
      "[appointmentSvc] DB insert failed for pending token booking — nettu hold left in place",
    );
    throw Object.assign(new Error("Database error saving pending booking"), { code: "DATABASE_ERROR", statusCode: 500 });
  }

  return { pendingBookingId: data.id, amountPaise, expiresAt: data.expiresAt, appointmentId };
}

// Public-safe summary for schedurx-form-agent's payment page (see
// api-v1-public.js) — same "id + clinicId together" capability model as
// every other public route, no separate patient login. Returns null (not a
// throw) for an unknown/wrong-clinic id so the route can 404 cleanly.
async function getPendingBookingById(supabaseClient, clinicId, pendingBookingId) {
  const { data: pending, error } = await supabaseClient
    .from("PendingBooking")
    .select("*")
    .eq("id", pendingBookingId)
    .eq("clinicId", clinicId)
    .maybeSingle();
  if (error) throw Object.assign(new Error(`DB error: ${error.message}`), { code: "DATABASE_ERROR", statusCode: 500 });
  if (!pending) return null;

  const [clinic, doctor] = await Promise.all([
    clinicSvc.getClinic(supabaseClient, clinicId),
    pending.doctorId ? doctorSvc.getDoctor(supabaseClient, pending.doctorId) : null,
  ]);

  return {
    id: pending.id,
    status: pending.status,
    timeslot: pending.timeslot,
    durationMinutes: pending.durationMinutes,
    amountPaise: pending.amountPaise,
    expiresAt: pending.expiresAt,
    patientName: pending.bookingParams?.patient?.fullName ?? pending.bookingParams?.patient?.name ?? null,
    clinic: clinic ? { id: clinic.id, name: clinic.name } : null,
    doctor: doctor ? { id: doctor.id, fullName: doctor.fullName } : null,
  };
}

// Called from stripe-webhook.js once Stripe confirms a token payment
// (checkout.session.completed with metadata.pendingBookingId). Idempotent —
// a Stripe retry, or a webhook firing twice, just no-ops the second time
// since the row is no longer status:"pending". Returns null (never throws)
// for an unknown id or a non-pending row, matching invoice-service.js's
// markPaidByStripeSession "defensive, never throws in a webhook path" shape.
async function finalizePendingBooking(nettuClient, supabaseClient, pendingBookingId, log, twilioClient) {
  const { data: pending, error } = await supabaseClient
    .from("PendingBooking")
    .select("*")
    .eq("id", pendingBookingId)
    .maybeSingle();
  if (error) throw Object.assign(new Error(`DB error: ${error.message}`), { code: "DATABASE_ERROR", statusCode: 500 });
  if (!pending) {
    log?.warn({ pendingBookingId }, "[appointmentSvc] finalizePendingBooking: unknown id");
    return null;
  }
  if (pending.status !== "pending") {
    log?.info({ pendingBookingId, status: pending.status }, "[appointmentSvc] finalizePendingBooking: not pending, skipping");
    return null;
  }

  const clinic = await clinicSvc.requireActiveClinic(supabaseClient, pending.clinicId);
  const doctor = await doctorSvc.requireActiveDoctor(supabaseClient, pending.doctorId, pending.clinicId);
  const clinicRules = clinicSvc.getSchedulingRules(clinic);
  const doctorRules = doctorSvc.getSchedulingRules(doctor, clinicRules);
  const timezone = doctorRules.timezone;
  const startMs = new Date(pending.timeslot).getTime();
  const durationMs = pending.durationMinutes * 60_000;

  const reservation = {
    clinic,
    doctor,
    timezone,
    startMs,
    endMs: startMs + durationMs,
    durationMs,
    isBlocked: false,
    appointmentId: pending.appointmentId,
    nettuEvent: { id: pending.schedulerEventId },
  };

  const appointment = await persistAppointment(
    nettuClient,
    supabaseClient,
    reservation,
    { ...pending.bookingParams, status: "booked", tokenRequested: true },
    log,
    twilioClient,
  );

  await supabaseClient
    .from("PendingBooking")
    .update({ status: "completed", updatedAt: new Date().toISOString() })
    .eq("id", pendingBookingId);

  return appointment;
}

// Run periodically (see server.js) — releases the nettu hold and marks any
// PendingBooking whose payment window lapsed without completing, so an
// abandoned Stripe checkout doesn't keep a slot locked forever.
async function expirePendingBookings(nettuClient, supabaseClient, log) {
  const { data: expired, error } = await supabaseClient
    .from("PendingBooking")
    .select("*")
    .eq("status", "pending")
    .lt("expiresAt", new Date().toISOString());
  if (error) {
    log?.error({ err: error }, "[appointmentSvc] expirePendingBookings: failed to list expired rows");
    return { expiredCount: 0 };
  }

  let expiredCount = 0;
  for (const row of expired ?? []) {
    if (row.schedulerEventId) {
      try {
        const { data: doctor } = await supabaseClient
          .from("Doctor")
          .select("schedulerDoctorId")
          .eq("id", row.doctorId)
          .maybeSingle();
        if (doctor?.schedulerDoctorId) {
          await nettuClient.deleteEvent(doctor.schedulerDoctorId, row.schedulerEventId);
        }
      } catch (err) {
        log?.warn({ err, pendingBookingId: row.id }, "[appointmentSvc] expirePendingBookings: couldn't delete nettu hold — continuing");
      }
    }
    const { error: updateErr } = await supabaseClient
      .from("PendingBooking")
      .update({ status: "expired", updatedAt: new Date().toISOString() })
      .eq("id", row.id);
    if (!updateErr) expiredCount += 1;
  }
  if (expiredCount) log?.info({ expiredCount }, "[appointmentSvc] expired stale pending token bookings");
  return { expiredCount };
}

// ─── Reschedule ───────────────────────────────────────────────────────────────

// opts: { appointmentId, clinicId, doctorId, newStart, newEnd?, reason?, source? }
async function rescheduleAppointment(nettuClient, supabaseClient, opts, log, twilioClient) {
  const { appointmentId, clinicId, doctorId, newStart, newEnd, reason, source = "system" } = opts;

  // Fetch the existing appointment.
  const { data: appt, error: fetchErr } = await supabaseClient
    .from("Appointment")
    .select("*")
    .eq("id", appointmentId)
    .maybeSingle();

  if (fetchErr)
    throw Object.assign(new Error(`DB error: ${fetchErr.message}`), { code: "DATABASE_ERROR", statusCode: 500 });
  if (!appt)
    throw Object.assign(new Error(`Appointment '${appointmentId}' not found`), {
      code: "APPOINTMENT_NOT_FOUND",
      statusCode: 404,
    });

  if (appt.clinicId !== clinicId) {
    throw Object.assign(new Error(`Appointment does not belong to clinic '${clinicId}'`), {
      code: "APPOINTMENT_NOT_FOUND",
      statusCode: 404,
    });
  }
  if (appt.status === "cancelled") {
    throw Object.assign(new Error("Cannot reschedule a cancelled appointment"), {
      code: "RESCHEDULE_NOT_ALLOWED",
      statusCode: 422,
    });
  }

  const clinic = await clinicSvc.requireActiveClinic(supabaseClient, clinicId);
  const doctor = await doctorSvc.requireActiveDoctor(supabaseClient, doctorId, clinicId);
  const clinicRules = clinicSvc.getSchedulingRules(clinic);
  const doctorRules = doctorSvc.getSchedulingRules(doctor, clinicRules);
  const timezone = doctorRules.timezone;

  // Enforce reschedule cutoff — skipped for a blocked-time entry, same as
  // cancelAppointment's identical exception (no patient to protect).
  if (appt.status !== "blocked" && appt.timeslot) {
    const originalStartMs = new Date(appt.timeslot).getTime();
    const cutoffMs = clinicRules.rescheduleCutoffHours * 60 * 60 * 1000;
    if (originalStartMs - Date.now() < cutoffMs) {
      throw Object.assign(
        new Error(
          `Appointments cannot be rescheduled within ${clinicRules.rescheduleCutoffHours} hours of the original start time`,
        ),
        { code: "RESCHEDULE_NOT_ALLOWED", statusCode: 422 },
      );
    }
  }

  const newStartMs = isoToEpochMs(newStart);
  const newEndMs = newEnd ? isoToEpochMs(newEnd) : newStartMs + doctorRules.slotDurationMins * 60 * 1000;

  if (newStartMs <= Date.now()) {
    throw Object.assign(new Error("New slot start time is in the past"), {
      code: "SLOT_NOT_AVAILABLE",
      statusCode: 422,
    });
  }

  log?.info({ appointmentId, newStart, source }, "[appointmentSvc] rescheduling appointment");

  // Delete the old nettu event and create a new booking.
  if (appt.schedulerEventId && doctor.schedulerDoctorId) {
    try {
      await nettuClient.deleteEvent(doctor.schedulerDoctorId, appt.schedulerEventId);
    } catch (err) {
      log?.warn(
        { err, appointmentId, eventId: appt.schedulerEventId },
        "[appointmentSvc] could not delete old nettu event — proceeding",
      );
    }
  }

  const newDurationMs = newEndMs - newStartMs;
  const isBlocked = appt.status === "blocked";
  // Rebuilt fresh against the new start time — reminders naturally recompute
  // to the rescheduled slot with no extra logic (config-driven ones use
  // clinic.settings.communication as it stands right now, not a stale
  // booking-time snapshot).
  const reminders = [
    { delta: -REMINDER_MINUTES_BEFORE, identifier: appointmentId },
    ...(isBlocked ? [] : commsWorkflowSvc.buildDelayedReminderEntries(clinic, appointmentId, newStartMs)),
  ];

  let newNettuEvent = null;
  try {
    newNettuEvent = await nettuClient.createEvent(doctor.schedulerDoctorId, {
      calendarId: doctor.schedulerCalendarId,
      startTs: newStartMs,
      durationMs: newDurationMs,
      busy: true,
      serviceId: clinic.schedulerServiceId,
      metadata: {
        clinicId,
        appointmentId,
        doctorId,
        kind: isBlocked ? "blocked" : "appointment",
        appointmentSource: source,
      },
      reminders,
    });
  } catch (err) {
    if (err.httpStatus === 409) {
      throw Object.assign(new Error("The new slot is no longer available"), {
        code: "SLOT_NOT_AVAILABLE",
        statusCode: 409,
      });
    }
    throw Object.assign(new Error(`Scheduler API error: ${err.message}`), {
      code: "SCHEDULER_API_ERROR",
      statusCode: 502,
    });
  }

  const now = new Date().toISOString();
  const auditEntry = buildAuditEntry("rescheduled", {
    actor: source,
    reason,
    oldStart: appt.timeslot,
    newStart,
  });

  const currentHistory = Array.isArray(appt.auditHistory) ? appt.auditHistory : [];

  const { data: updated, error: updateErr } = await supabaseClient
    .from("Appointment")
    .update({
      // See bookAppointment's identical fix above — always a genuine UTC
      // instant, never the raw (possibly offset-bearing) client string.
      timeslot: new Date(newStartMs).toISOString(),
      // Keep status as the pre-reschedule booking state (booked/blocked), not
      // a literal "rescheduled" — that's an event, already captured by
      // rescheduledAt/oldStart/auditHistory below, not a status. The frontend
      // has no mapping for a "rescheduled" status string and would otherwise
      // silently render the appointment as "tentative".
      status: isBlocked ? "blocked" : "booked",
      schedulerEventId: newNettuEvent?.id ?? null,
      rescheduledAt: now,
      rescheduleReason: reason ?? null,
      oldStart: appt.timeslot ?? null,
      oldEnd: null,
      auditHistory: [...currentHistory, auditEntry],
      updatedAt: now,
    })
    .eq("id", appointmentId)
    .select()
    .single();

  if (updateErr) {
    log?.error({ err: updateErr, appointmentId }, "[appointmentSvc] DB update failed after reschedule");
    throw Object.assign(new Error("Database error updating appointment"), { code: "DATABASE_ERROR", statusCode: 500 });
  }

  log?.info(
    { appointmentId, newStart, newNettuEventId: newNettuEvent?.id },
    "[appointmentSvc] appointment rescheduled",
  );

  if (!isBlocked && appt.patientId) {
    const { data: patient } = await supabaseClient
      .from("Patient")
      .select("fullName, contactNumber")
      .eq("id", appt.patientId)
      .maybeSingle();
    if (patient?.contactNumber) {
      await commsWorkflowSvc.sendImmediateWorkflowMessages(
        {
          supabaseClient,
          twilioClient,
          clinic,
          trigger: "reschedule",
          appointmentId,
          toPhone: patient.contactNumber,
          data: {
            clinicName: clinic.name,
            clinicPhone: clinic.phone,
            doctorName: doctor.fullName,
            patientName: patient.fullName,
            oldApptTime: appt.timeslot ? formatHumanTime(new Date(appt.timeslot).getTime(), timezone) : null,
            apptTime: formatHumanTime(newStartMs, timezone),
            bookingUrl: bookingUrlFor(clinicId, appointmentId),
            bookingUrlPath: `${clinicId}/${appointmentId}`,
          },
        },
        log,
      );
    }
  }

  return {
    appointmentId,
    status: "rescheduled",
    oldStart: appt.timeslot ?? null,
    oldEnd: null,
    newStart: epochToISO(newStartMs, timezone),
    newEnd: epochToISO(newEndMs, timezone),
  };
}

// ─── Cancel ───────────────────────────────────────────────────────────────────

// opts: { appointmentId, clinicId, reason?, source? }
async function cancelAppointment(nettuClient, supabaseClient, opts, log, twilioClient) {
  const { appointmentId, clinicId, reason, source = "system", bypassCutoff = false } = opts;

  const { data: appt, error: fetchErr } = await supabaseClient
    .from("Appointment")
    .select("*")
    .eq("id", appointmentId)
    .maybeSingle();

  if (fetchErr)
    throw Object.assign(new Error(`DB error: ${fetchErr.message}`), { code: "DATABASE_ERROR", statusCode: 500 });
  if (!appt)
    throw Object.assign(new Error(`Appointment '${appointmentId}' not found`), {
      code: "APPOINTMENT_NOT_FOUND",
      statusCode: 404,
    });

  if (appt.clinicId !== clinicId) {
    throw Object.assign(new Error(`Appointment does not belong to clinic '${clinicId}'`), {
      code: "APPOINTMENT_NOT_FOUND",
      statusCode: 404,
    });
  }
  if (appt.status === "cancelled") {
    throw Object.assign(new Error("Appointment is already cancelled"), {
      code: "APPOINTMENT_ALREADY_CANCELLED",
      statusCode: 422,
    });
  }

  const clinic = await clinicSvc.requireActiveClinic(supabaseClient, clinicId);
  const clinicRules = clinicSvc.getSchedulingRules(clinic);

  // Enforce cancellation cutoff — skipped for a blocked-time entry (no
  // patient to protect) and for a staff-forced override (e.g. a new block
  // displacing this appointment; see bookAppointment's conflict-cancel step).
  if (appt.status !== "blocked" && !bypassCutoff && appt.timeslot) {
    const appointmentMs = new Date(appt.timeslot).getTime();
    const cutoffMs = clinicRules.cancellationCutoffHours * 60 * 60 * 1000;
    if (appointmentMs - Date.now() < cutoffMs) {
      throw Object.assign(
        new Error(
          `Appointments cannot be cancelled within ${clinicRules.cancellationCutoffHours} hours of the start time`,
        ),
        { code: "CANCELLATION_NOT_ALLOWED", statusCode: 422 },
      );
    }
  }

  log?.info({ appointmentId, clinicId, source }, "[appointmentSvc] cancelling appointment");

  // Remove the event from nettu-scheduler.
  // Widened to include fullName (not just schedulerDoctorId) since a
  // cancellation notice, if configured, needs the doctor's name — this
  // lookup already existed for deleteEvent, no extra query added.
  let doctor = null;
  if (appt.doctorId) {
    const { data } = await supabaseClient
      .from("Doctor")
      .select("schedulerDoctorId, fullName")
      .eq("id", appt.doctorId)
      .maybeSingle();
    doctor = data;
  }

  if (appt.schedulerEventId && appt.doctorId) {
    if (doctor?.schedulerDoctorId) {
      try {
        await nettuClient.deleteEvent(doctor.schedulerDoctorId, appt.schedulerEventId);
      } catch (err) {
        log?.warn(
          { err, appointmentId, eventId: appt.schedulerEventId },
          "[appointmentSvc] could not delete nettu event — continuing with DB cancel",
        );
      }
    }
  }

  const now = new Date().toISOString();
  const auditEntry = buildAuditEntry("cancelled", { actor: source, reason });
  const currentHistory = Array.isArray(appt.auditHistory) ? appt.auditHistory : [];

  // .eq("status", appt.status) makes this an optimistic-concurrency claim,
  // not a blind write — the earlier `appt.status === "cancelled"` check
  // above only guards against an *already*-cancelled appointment, not a
  // second request racing this exact one (confirmed live: two concurrent
  // cancels both returned 200 and both would have sent their own
  // cancellation notice below). If another request already changed this
  // row's status between our read and this write, zero rows match and
  // `updated` comes back null — that's "lost the race," not a fresh
  // success, so it must not fall through to sending comms again.
  const { data: updated, error: updateErr } = await supabaseClient
    .from("Appointment")
    .update({
      status: "cancelled",
      cancelledAt: now,
      cancellationReason: reason ?? null,
      source,
      auditHistory: [...currentHistory, auditEntry],
      updatedAt: now,
    })
    .eq("id", appointmentId)
    .eq("status", appt.status)
    .select()
    .maybeSingle();

  if (updateErr) {
    log?.error({ err: updateErr, appointmentId }, "[appointmentSvc] DB update failed after cancel");
    throw Object.assign(new Error("Database error cancelling appointment"), {
      code: "DATABASE_ERROR",
      statusCode: 500,
    });
  }

  if (!updated) {
    log?.info({ appointmentId }, "[appointmentSvc] lost the race to cancel this appointment — another request already changed it");
    throw Object.assign(new Error("Appointment is already cancelled"), {
      code: "APPOINTMENT_ALREADY_CANCELLED",
      statusCode: 422,
    });
  }

  log?.info({ appointmentId }, "[appointmentSvc] appointment cancelled");

  if (appt.status !== "blocked" && appt.patientId) {
    const { data: patient } = await supabaseClient
      .from("Patient")
      .select("fullName, contactNumber")
      .eq("id", appt.patientId)
      .maybeSingle();
    if (patient?.contactNumber) {
      await commsWorkflowSvc.sendImmediateWorkflowMessages(
        {
          supabaseClient,
          twilioClient,
          clinic,
          trigger: "cancellation",
          appointmentId,
          toPhone: patient.contactNumber,
          data: {
            clinicName: clinic.name,
            clinicPhone: clinic.phone,
            doctorName: doctor?.fullName,
            patientName: patient.fullName,
            apptTime: appt.timeslot ? formatHumanTime(new Date(appt.timeslot).getTime(), clinicRules.timezone) : null,
            reason: reason ?? null,
          },
        },
        log,
      );
    }
  }

  return {
    appointmentId,
    status: "cancelled",
    clinicId,
    doctorId: appt.doctorId,
    cancelledAt: now,
    reason: reason ?? null,
  };
}

// ─── Check-in lifecycle: completed / no-show ───────────────────────────────
// Neither touches nettu-scheduler — the calendar slot itself isn't released
// on a no-show (see the check-in plan's "not this round" scope). These only
// move the Appointment row's own status (+ audit trail), plus a no-show's
// best-effort patient-facing nudge.

async function markCompleted(supabaseClient, { appointmentId, clinicId }, log, twilioClient) {
  const { data: appt, error: fetchErr } = await supabaseClient
    .from("Appointment")
    .select("id, clinicId, doctorId, patientId, timeslot, symptoms, mode, status, auditHistory")
    .eq("id", appointmentId)
    .maybeSingle();
  if (fetchErr)
    throw Object.assign(new Error(`DB error: ${fetchErr.message}`), { code: "DATABASE_ERROR", statusCode: 500 });
  if (!appt || appt.clinicId !== clinicId) {
    throw Object.assign(new Error(`Appointment '${appointmentId}' not found`), {
      code: "APPOINTMENT_NOT_FOUND",
      statusCode: 404,
    });
  }
  // Idempotent — advancing the queue past someone already marked complete
  // (e.g. a double "next" click racing itself) shouldn't error, and
  // shouldn't re-fire the thank-you message a second time.
  if (appt.status === "completed") return { appointmentId, status: "completed" };

  const currentHistory = Array.isArray(appt.auditHistory) ? appt.auditHistory : [];
  const { error: updateErr } = await supabaseClient
    .from("Appointment")
    .update({
      status: "completed",
      auditHistory: [...currentHistory, buildAuditEntry("completed", {})],
      updatedAt: new Date().toISOString(),
    })
    .eq("id", appointmentId);
  if (updateErr) {
    log?.error({ err: updateErr, appointmentId }, "[appointmentSvc] DB update failed after completing appointment");
    throw Object.assign(new Error("Database error completing appointment"), {
      code: "DATABASE_ERROR",
      statusCode: 500,
    });
  }

  // Best-effort from here on — neither the Visit guarantee nor the
  // thank-you send should undo or fail the completion itself, same posture
  // as every other comms trigger in this file.
  if (appt.patientId) {
    try {
      await visitSvc.findOrCreateTodaysVisit(supabaseClient, {
        clinicId,
        patientId: appt.patientId,
        doctorId: appt.doctorId,
        appointmentId,
        mode: appt.mode,
        symptoms: appt.symptoms,
      });
    } catch (err) {
      log?.error({ err, appointmentId }, "[appointmentSvc] couldn't guarantee a Visit row on completion");
    }

    try {
      const clinic = await clinicSvc.getClinic(supabaseClient, clinicId);
      const clinicRules = clinicSvc.getSchedulingRules(clinic ?? {});
      const [{ data: patient }, { data: doctor }] = await Promise.all([
        supabaseClient.from("Patient").select("fullName, contactNumber").eq("id", appt.patientId).maybeSingle(),
        appt.doctorId
          ? supabaseClient.from("Doctor").select("fullName").eq("id", appt.doctorId).maybeSingle()
          : Promise.resolve({ data: null }),
      ]);
      if (patient?.contactNumber) {
        await commsWorkflowSvc.sendImmediateWorkflowMessages(
          {
            supabaseClient,
            twilioClient,
            clinic,
            trigger: "post_appointment",
            appointmentId,
            toPhone: patient.contactNumber,
            data: {
              clinicName: clinic?.name,
              clinicPhone: clinic?.phone,
              doctorName: doctor?.fullName,
              patientName: patient.fullName,
              apptTime: appt.timeslot ? formatHumanTime(new Date(appt.timeslot).getTime(), clinicRules.timezone) : null,
            },
          },
          log,
        );
      }
    } catch (err) {
      log?.error({ err, appointmentId }, "[appointmentSvc] post-appointment thank-you send failed");
    }
  }

  return { appointmentId, status: "completed" };
}

// Reverses markCompleted — called when the queue's "prev" direction
// resurrects a done entry, so the two states can't drift out of sync.
// Best-effort: never throws, since undoing a queue step shouldn't fail just
// because its appointment link turned out stale.
async function revertCompleted(supabaseClient, { appointmentId, clinicId }, log) {
  try {
    const { data: appt } = await supabaseClient
      .from("Appointment")
      .select("id, clinicId, status")
      .eq("id", appointmentId)
      .maybeSingle();
    if (!appt || appt.clinicId !== clinicId || appt.status !== "completed") return;
    await supabaseClient.from("Appointment").update({ status: "booked", updatedAt: new Date().toISOString() }).eq("id", appointmentId);
  } catch (err) {
    log?.warn({ err, appointmentId }, "[appointmentSvc] couldn't revert completed status");
  }
}

// Staff-confirmed only (see webhooks-nettu.js/comms-workflow-service.js for
// the reminder side of "give them every reason to show up" — this is what
// happens when they still don't). Never auto-fires from a background sweep;
// the caller (api-v1-queue.js) only ever reaches this from an explicit
// staff tap, matching the check-in plan's "a person confirms it" scope.
async function markNoShow(supabaseClient, { appointmentId, clinicId }, log, twilioClient) {
  const { data: appt, error: fetchErr } = await supabaseClient
    .from("Appointment")
    .select("id, clinicId, doctorId, patientId, timeslot, status, auditHistory")
    .eq("id", appointmentId)
    .maybeSingle();
  if (fetchErr)
    throw Object.assign(new Error(`DB error: ${fetchErr.message}`), { code: "DATABASE_ERROR", statusCode: 500 });
  if (!appt || appt.clinicId !== clinicId) {
    throw Object.assign(new Error(`Appointment '${appointmentId}' not found`), {
      code: "APPOINTMENT_NOT_FOUND",
      statusCode: 404,
    });
  }
  if (appt.status !== "booked") {
    throw Object.assign(new Error(`Appointment is '${appt.status}', not 'booked' — can't mark it a no-show`), {
      code: "APPOINTMENT_NOT_BOOKED",
      statusCode: 422,
    });
  }

  const currentHistory = Array.isArray(appt.auditHistory) ? appt.auditHistory : [];
  const { error: updateErr } = await supabaseClient
    .from("Appointment")
    .update({
      status: "no_show",
      auditHistory: [...currentHistory, buildAuditEntry("no_show", {})],
      updatedAt: new Date().toISOString(),
    })
    .eq("id", appointmentId);
  if (updateErr) {
    log?.error({ err: updateErr, appointmentId }, "[appointmentSvc] DB update failed marking no-show");
    throw Object.assign(new Error("Database error marking no-show"), { code: "DATABASE_ERROR", statusCode: 500 });
  }
  log?.info({ appointmentId, clinicId }, "[appointmentSvc] appointment marked no-show");

  // Fetched regardless of the messaging send below (which is best-effort) —
  // the caller (api-v1-queue.js) uses these for its staff Notification too.
  let patient = null;
  let doctor = null;
  let apptTime = null;
  if (appt.patientId) {
    const clinic = await clinicSvc.getClinic(supabaseClient, clinicId);
    const clinicRules = clinicSvc.getSchedulingRules(clinic ?? {});
    apptTime = appt.timeslot ? formatHumanTime(new Date(appt.timeslot).getTime(), clinicRules.timezone) : null;
    [{ data: patient }, { data: doctor }] = await Promise.all([
      supabaseClient.from("Patient").select("fullName, contactNumber").eq("id", appt.patientId).maybeSingle(),
      appt.doctorId
        ? supabaseClient.from("Doctor").select("fullName").eq("id", appt.doctorId).maybeSingle()
        : Promise.resolve({ data: null }),
    ]);

    // Best-effort patient nudge — a messaging failure must never undo (or
    // even surface as a failure of) the no-show confirmation itself, same
    // posture as every other comms trigger in this file.
    if (patient?.contactNumber) {
      try {
        await commsWorkflowSvc.sendImmediateWorkflowMessages(
          {
            supabaseClient,
            twilioClient,
            clinic,
            trigger: "no_show",
            appointmentId,
            toPhone: patient.contactNumber,
            data: {
              clinicName: clinic?.name,
              clinicPhone: clinic?.phone,
              doctorName: doctor?.fullName,
              patientName: patient.fullName,
              apptTime,
            },
          },
          log,
        );
      } catch (err) {
        log?.error({ err, appointmentId }, "[appointmentSvc] no-show patient nudge failed");
      }
    }
  }

  return {
    appointmentId,
    status: "no_show",
    patientName: patient?.fullName ?? null,
    doctorName: doctor?.fullName ?? null,
    apptTime,
  };
}

// ─── Bulk reschedule / cancel ───────────────────────────────────────────────
// Thin sequential wrappers over the single-record functions above — every
// cutoff check, nettu call, and comms trigger they already do runs exactly
// as it would one at a time, just looped. Sequential (not Promise.all) on
// purpose: keeps nettu-scheduler calls from racing each other and keeps one
// item's failure from being ambiguous about which one it was. Capped so a
// single tool call can't accidentally sweep up hundreds of records — the
// caller (an assistant tool) should narrow its own filter instead.
const MAX_BULK_APPOINTMENTS = 20;

function summarizeBulkResults(results) {
  return { results, succeeded: results.filter((r) => r.ok).length, failed: results.filter((r) => !r.ok).length };
}

// opts: { clinicId, appointmentIds: string[], newStart?, shiftByDays?, shiftByMinutes?, reason?, source? }
// newStart (an absolute new time) only makes sense for exactly one
// appointment — for more than one, every appointment keeps its own original
// time-of-day and only shifts by shiftByDays/shiftByMinutes (e.g. "move all
// my bookings to tomorrow" preserves each one's own hour).
async function rescheduleAppointments(nettuClient, supabaseClient, opts, log, twilioClient) {
  const { clinicId, appointmentIds, newStart, shiftByDays, shiftByMinutes, reason, source = "system" } = opts;
  if (!Array.isArray(appointmentIds) || appointmentIds.length === 0) {
    throw Object.assign(new Error("appointmentIds must be a non-empty array"), { code: "MISSING_FIELDS", statusCode: 422 });
  }
  if (appointmentIds.length > MAX_BULK_APPOINTMENTS) {
    throw Object.assign(new Error(`Can't act on more than ${MAX_BULK_APPOINTMENTS} appointments in one request`), {
      code: "TOO_MANY_APPOINTMENTS",
      statusCode: 422,
    });
  }
  if (appointmentIds.length > 1 && newStart) {
    throw Object.assign(new Error("newStart only applies to a single appointment — use shiftByDays/shiftByMinutes for more than one"), {
      code: "INVALID_BULK_RESCHEDULE",
      statusCode: 422,
    });
  }
  const shiftMs = (shiftByDays ?? 0) * 24 * 60 * 60 * 1000 + (shiftByMinutes ?? 0) * 60 * 1000;
  if (!newStart && shiftMs === 0) {
    throw Object.assign(new Error("Provide either newStart or a non-zero shiftByDays/shiftByMinutes"), {
      code: "MISSING_FIELDS",
      statusCode: 422,
    });
  }

  const results = [];
  for (const appointmentId of appointmentIds) {
    try {
      const { data: appt, error } = await supabaseClient
        .from("Appointment")
        .select("doctorId, timeslot")
        .eq("id", appointmentId)
        .eq("clinicId", clinicId)
        .maybeSingle();
      if (error) throw Object.assign(new Error(`DB error: ${error.message}`), { code: "DATABASE_ERROR" });
      if (!appt) throw Object.assign(new Error(`Appointment '${appointmentId}' not found`), { code: "APPOINTMENT_NOT_FOUND" });

      let computedNewStart = newStart;
      if (!computedNewStart) {
        if (!appt.timeslot) throw Object.assign(new Error("No original time to shift from"), { code: "INVALID_BULK_RESCHEDULE" });
        computedNewStart = new Date(new Date(appt.timeslot).getTime() + shiftMs).toISOString();
      }

      const result = await rescheduleAppointment(
        nettuClient,
        supabaseClient,
        { appointmentId, clinicId, doctorId: appt.doctorId, newStart: computedNewStart, reason, source },
        log,
        twilioClient,
      );
      results.push({ appointmentId, ok: true, ...result });
    } catch (err) {
      results.push({ appointmentId, ok: false, error: err.message, code: err.code ?? null });
    }
  }
  return summarizeBulkResults(results);
}

// opts: { clinicId, appointmentIds: string[], reason?, source? }
async function cancelAppointments(nettuClient, supabaseClient, opts, log, twilioClient) {
  const { clinicId, appointmentIds, reason, source = "system" } = opts;
  if (!Array.isArray(appointmentIds) || appointmentIds.length === 0) {
    throw Object.assign(new Error("appointmentIds must be a non-empty array"), { code: "MISSING_FIELDS", statusCode: 422 });
  }
  if (appointmentIds.length > MAX_BULK_APPOINTMENTS) {
    throw Object.assign(new Error(`Can't act on more than ${MAX_BULK_APPOINTMENTS} appointments in one request`), {
      code: "TOO_MANY_APPOINTMENTS",
      statusCode: 422,
    });
  }

  const results = [];
  for (const appointmentId of appointmentIds) {
    try {
      const result = await cancelAppointment(nettuClient, supabaseClient, { appointmentId, clinicId, reason, source }, log, twilioClient);
      results.push({ appointmentId, ok: true, ...result });
    } catch (err) {
      results.push({ appointmentId, ok: false, error: err.message, code: err.code ?? null });
    }
  }
  return summarizeBulkResults(results);
}

module.exports = {
  bookAppointment,
  rescheduleAppointment,
  cancelAppointment,
  rescheduleAppointments,
  cancelAppointments,
  validateAndReserveSlot,
  persistAppointment,
  createPendingTokenBooking,
  getPendingBookingById,
  finalizePendingBooking,
  expirePendingBookings,
  markCompleted,
  revertCompleted,
  markNoShow,
};
