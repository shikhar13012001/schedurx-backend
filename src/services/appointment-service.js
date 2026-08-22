// Calendar-integrated appointment booking, rescheduling, and cancellation.
// Creates and manages nettu-scheduler events alongside Supabase appointment records.

const crypto = require("node:crypto");
const clinicSvc = require("./clinic-service");
const doctorSvc = require("./doctor-service");
const { epochToISO, formatHumanTime, toDateString } = require("./availability-service");
const commsWorkflowSvc = require("./comms-workflow-service");
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
async function bookAppointment(nettuClient, supabaseClient, opts, log, twilioClient) {
  const {
    clinicId,
    doctorId,
    patientId,
    start,
    end,
    patient,
    appointmentType,
    reason,
    source = "system",
    bookerRelation = "self",
    proxyName,
    notes,
    status = "booked",
  } = opts;

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

  // Generated up front (not after the nettu call) so it can ride along in
  // the event's metadata — the reminder webhook only gets the CalendarEvent
  // back, not our own request context, so this is how it knows which
  // Appointment/Notification to create.
  const now = new Date().toISOString();
  const appointmentId = `apt_${crypto.randomUUID()}`;

  // Create a busy calendar event in nettu (marks slot as taken).
  // serviceId links the event to the clinic's service for conflict detection.
  // reminders: the staff -15min entry (bare appointmentId identifier) plus one
  // entry per the clinic's configured delayed comms workflows (composite
  // "<appointmentId>::<workflowId>" identifier) — see webhooks-nettu.js for
  // what happens on receipt of each. Blocked-time entries have no patient, so
  // they only ever get the staff entry, never workflow ones.
  const isBlocked = status === "blocked";
  const reminders = [
    { delta: -REMINDER_MINUTES_BEFORE, identifier: appointmentId },
    ...(isBlocked ? [] : commsWorkflowSvc.buildDelayedReminderEntries(clinic, appointmentId)),
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

  // Persist to Supabase.
  const auditEntry = buildAuditEntry("created", { actor: source, reason });

  const { data: appointment, error } = await supabaseClient
    .from("Appointment")
    .insert({
      id: appointmentId,
      clinicId,
      patientId: patientId ?? null,
      doctorId,
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
      schedulerEventId: nettuEvent?.id ?? null,
      source,
      auditHistory: [auditEntry],
      createdAt: now,
      updatedAt: now,
    })
    .select()
    .single();

  if (error) {
    // DB failed after the nettu event was created — log for manual reconciliation.
    log?.error(
      { err: error, nettuEventId: nettuEvent?.id, clinicId, doctorId },
      "[appointmentSvc] DB insert failed after nettu event created — manual reconciliation needed",
    );
    throw Object.assign(new Error("Database error saving appointment"), { code: "DATABASE_ERROR", statusCode: 500 });
  }

  log?.info({ appointmentId, nettuEventId: nettuEvent?.id, doctorId, clinicId }, "[appointmentSvc] appointment booked");

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
          bookingUrl: bookingUrlFor(clinicId, appointmentId),
          // Suffix-only form of bookingUrl, for Content Template URL buttons —
          // Meta/Twilio only allow a variable at the end of an already-fixed
          // base URL on a button component, never the whole URL as one variable.
          bookingUrlPath: `${clinicId}/${appointmentId}`,
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
    patient: { name: patient?.name ?? null, phone: patient?.phone ?? null },
    source: appointment.source,
  };
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

  // Enforce reschedule cutoff.
  if (appt.timeslot) {
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
    ...(isBlocked ? [] : commsWorkflowSvc.buildDelayedReminderEntries(clinic, appointmentId)),
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
  const { appointmentId, clinicId, reason, source = "system" } = opts;

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

  // Enforce cancellation cutoff.
  if (appt.timeslot) {
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

  const { error: updateErr } = await supabaseClient
    .from("Appointment")
    .update({
      status: "cancelled",
      cancelledAt: now,
      cancellationReason: reason ?? null,
      source,
      auditHistory: [...currentHistory, auditEntry],
      updatedAt: now,
    })
    .eq("id", appointmentId);

  if (updateErr) {
    log?.error({ err: updateErr, appointmentId }, "[appointmentSvc] DB update failed after cancel");
    throw Object.assign(new Error("Database error cancelling appointment"), {
      code: "DATABASE_ERROR",
      statusCode: 500,
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

module.exports = { bookAppointment, rescheduleAppointment, cancelAppointment, rescheduleAppointments, cancelAppointments };
