// Live clinic queue — walk-ins, check-ins, and the doctor's "now serving" state.
// Every write here is also what a Supabase Realtime `postgres_changes`
// subscription on QueueItem broadcasts to connected dashboards.

const { makeId } = require("../lib/ids");
const appointmentSvc = require("./appointment-service");
const visitSvc = require("./visit-service");

// How long staff has, past a booking's start time, before it's surfaced as
// a *possible* no-show (never auto-finalized — see markNoShow in
// appointment-service.js, the only thing that actually changes status).
// Overridable per clinic via settings.checkIn.noShowGraceMinutes.
const DEFAULT_NO_SHOW_GRACE_MINUTES = 20;

// How far back the possible-no-show scan looks. Bounds the query so a
// booking nobody ever resolved (stale test data, a clinic that just ignored
// it for days) doesn't pile up in this list forever — staff can still
// resolve those the normal way (cancel/reschedule) without this feature
// surfacing them indefinitely.
const NO_SHOW_LOOKBACK_HOURS = 24;

function dbErr(msg) {
  return Object.assign(new Error(`DB error ${msg}`), { code: "DATABASE_ERROR", statusCode: 500 });
}
function notFound(id) {
  return Object.assign(new Error(`Queue item '${id}' not found`), { code: "QUEUE_ITEM_NOT_FOUND", statusCode: 404 });
}

async function listQueue(supabaseClient, clinicId, { doctorId } = {}) {
  let query = supabaseClient.from("QueueItem").select("*").eq("clinicId", clinicId).neq("status", "done");
  if (doctorId) query = query.eq("doctorId", doctorId);

  const { data, error } = await query.order("position", { ascending: true });
  if (error) throw dbErr(`listing queue: ${error.message}`);
  return data ?? [];
}

// Doubles as "check a booked patient in" when appointmentId is given — same
// entry point, same QueueItem row shape, just derived from the real booking
// server-side (never trusting the client's doctorId/patientId for that case,
// matching every other booking entry point in this codebase) instead of
// walk-in-style client-supplied fields, and tagged walkIn:false accordingly.
async function addWalkIn(supabaseClient, { clinicId, doctorId, patientId, displayName, phoneNumber, appointmentId }) {
  let resolvedDoctorId = doctorId;
  let resolvedPatientId = patientId ?? null;
  let isWalkIn = true;

  if (appointmentId) {
    const { data: appt, error: apptErr } = await supabaseClient
      .from("Appointment")
      .select("id, clinicId, doctorId, patientId, status")
      .eq("id", appointmentId)
      .maybeSingle();
    if (apptErr) throw dbErr(`looking up appointment: ${apptErr.message}`);
    if (!appt || appt.clinicId !== clinicId) {
      throw Object.assign(new Error(`Appointment '${appointmentId}' not found`), {
        code: "APPOINTMENT_NOT_FOUND",
        statusCode: 404,
      });
    }
    if (appt.status !== "booked") {
      throw Object.assign(new Error(`Appointment is '${appt.status}', not 'booked' — can't check in`), {
        code: "APPOINTMENT_NOT_BOOKED",
        statusCode: 422,
      });
    }

    const { data: existing, error: existingErr } = await supabaseClient
      .from("QueueItem")
      .select("id")
      .eq("appointmentId", appointmentId)
      .neq("status", "done")
      .maybeSingle();
    if (existingErr) throw dbErr(`checking existing queue entry: ${existingErr.message}`);
    if (existing) {
      throw Object.assign(new Error("This appointment is already checked in"), {
        code: "ALREADY_CHECKED_IN",
        statusCode: 422,
      });
    }

    resolvedDoctorId = appt.doctorId;
    resolvedPatientId = appt.patientId;
    isWalkIn = false;
  }

  if (!resolvedDoctorId) {
    throw Object.assign(new Error("doctorId is required"), { code: "MISSING_FIELDS", statusCode: 422 });
  }

  const { data: maxRow } = await supabaseClient
    .from("QueueItem")
    .select("position")
    .eq("clinicId", clinicId)
    .eq("doctorId", resolvedDoctorId)
    .order("position", { ascending: false })
    .limit(1)
    .maybeSingle();

  const now = new Date().toISOString();
  const { data, error } = await supabaseClient
    .from("QueueItem")
    .insert({
      id: makeId("queue"),
      clinicId,
      doctorId: resolvedDoctorId,
      patientId: resolvedPatientId,
      appointmentId: appointmentId ?? null,
      displayName: displayName ?? null,
      phoneNumber: phoneNumber ?? null,
      status: "waiting",
      position: (maxRow?.position ?? 0) + 1,
      walkIn: isWalkIn,
      checkedInAt: now,
      createdAt: now,
      updatedAt: now,
    })
    .select()
    .single();

  if (error) throw dbErr(`adding walk-in: ${error.message}`);
  return data;
}

async function getCurrentInRoom(supabaseClient, clinicId, doctorId) {
  const { data, error } = await supabaseClient
    .from("QueueItem")
    .select("*")
    .eq("clinicId", clinicId)
    .eq("doctorId", doctorId)
    .eq("status", "in_room")
    .maybeSingle();
  if (error) throw dbErr(`fetching current queue item: ${error.message}`);
  return data ?? null;
}

async function setStatus(supabaseClient, id, patch) {
  const { data, error } = await supabaseClient
    .from("QueueItem")
    .update({ ...patch, updatedAt: new Date().toISOString() })
    .eq("id", id)
    .select()
    .single();
  if (error) throw dbErr(`updating queue item: ${error.message}`);
  return data;
}

// direction: "next" | "prev" | "jumpTo" | "complete" (jumpTo requires targetId)
async function advance(supabaseClient, { clinicId, doctorId, direction, targetId }, log, twilioClient) {
  const now = new Date().toISOString();
  const current = await getCurrentInRoom(supabaseClient, clinicId, doctorId);

  // "Checkout" — marks the visit complete but deliberately does NOT touch
  // QueueItem.status or promote the next waiting patient. Live-reported bug
  // (2026-09-02): Checkout used to call the same path as "next", so it also
  // silently advanced the queue — the doctor lost the current patient off
  // their screen the instant they tapped Checkout, before ever meaning to
  // move on. Deliberately not flipping status to "done" here either: doing
  // so would drop this item out of activeQueue()'s filter, and
  // useCurrentPatient's "in_room ?? first active" fallback would then show
  // the *next* patient as current as a side effect — exactly the behavior
  // this exists to prevent. markCompleted is idempotent, so the "next"
  // branch below still runs safely (no duplicate thank-you message) once
  // the doctor actually taps '>'.
  if (direction === "complete") {
    if (!current) {
      throw Object.assign(new Error("No patient currently in room"), { code: "NO_CURRENT_PATIENT", statusCode: 422 });
    }
    if (current.appointmentId) {
      await appointmentSvc.markCompleted(supabaseClient, { appointmentId: current.appointmentId, clinicId }, log, twilioClient);
    }
    // Best-effort, never blocks checkout — markCompleted (above) already
    // guarantees today's Visit row exists once a real appointment is
    // linked. If the doctor attached a photo Rx during the consult but
    // never explicitly sent it, send it now rather than leaving it sitting
    // unsent until someone remembers to open the patient file.
    if (current.patientId) {
      try {
        const visit = await visitSvc.findOrCreateTodaysVisit(supabaseClient, {
          clinicId,
          patientId: current.patientId,
          doctorId,
          appointmentId: current.appointmentId,
        });
        const unsentPhoto = (visit.rxAttachments ?? []).find((a) => a.type === "photo" && !a.sentAt);
        if (unsentPhoto) {
          await visitSvc.sendAttachment(supabaseClient, twilioClient, {
            clinicId,
            visitId: visit.id,
            path: unsentPhoto.path,
            staffId: null,
            staffContext: null,
          }, log);
        }
      } catch (err) {
        log?.warn({ err, patientId: current.patientId }, "[queueSvc] couldn't auto-send the photo Rx on checkout");
      }
    }
    return { nowServing: current };
  }

  if (direction === "jumpTo") {
    if (!targetId)
      throw Object.assign(new Error("targetId is required for jumpTo"), { code: "MISSING_TARGET", statusCode: 422 });
    if (current) await setStatus(supabaseClient, current.id, { status: "waiting", calledAt: null });
    const target = await setStatus(supabaseClient, targetId, { status: "in_room", calledAt: now, completedAt: null });
    return { nowServing: target };
  }

  if (direction === "next") {
    if (current) {
      await setStatus(supabaseClient, current.id, { status: "done", completedAt: now });
      // Best-effort — a completed-status sync failure shouldn't block moving
      // the queue on to the next patient.
      if (current.appointmentId) {
        try {
          await appointmentSvc.markCompleted(supabaseClient, { appointmentId: current.appointmentId, clinicId }, log, twilioClient);
        } catch (err) {
          log?.warn({ err, appointmentId: current.appointmentId }, "[queueSvc] couldn't mark appointment completed");
        }
      }
    }

    const { data: nextWaiting, error } = await supabaseClient
      .from("QueueItem")
      .select("*")
      .eq("clinicId", clinicId)
      .eq("doctorId", doctorId)
      .eq("status", "waiting")
      .order("position", { ascending: true })
      .limit(1)
      .maybeSingle();
    if (error) throw dbErr(`finding next queue item: ${error.message}`);
    if (!nextWaiting) return { nowServing: null };

    const target = await setStatus(supabaseClient, nextWaiting.id, { status: "in_room", calledAt: now });
    return { nowServing: target };
  }

  if (direction === "prev") {
    if (current) await setStatus(supabaseClient, current.id, { status: "waiting", calledAt: null });

    const { data: lastDone, error } = await supabaseClient
      .from("QueueItem")
      .select("*")
      .eq("clinicId", clinicId)
      .eq("doctorId", doctorId)
      .eq("status", "done")
      .order("completedAt", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error) throw dbErr(`finding previous queue item: ${error.message}`);
    if (!lastDone) return { nowServing: null };

    // Keeps the appointment in sync with the queue entry it's tied to —
    // resurrecting a "done" item out of the queue shouldn't leave its
    // appointment stuck at "completed".
    if (lastDone.appointmentId) {
      await appointmentSvc.revertCompleted(supabaseClient, { appointmentId: lastDone.appointmentId, clinicId }, log);
    }

    const target = await setStatus(supabaseClient, lastDone.id, {
      status: "in_room",
      calledAt: now,
      completedAt: null,
    });
    return { nowServing: target };
  }

  throw Object.assign(new Error(`Unknown direction '${direction}'`), { code: "INVALID_DIRECTION", statusCode: 422 });
}

// Booked appointments, today-ish, past the clinic's grace period from their
// own start time, with no queue entry ever created for them — surfaced to
// staff as *possible* no-shows. Purely computed on read, nothing persisted:
// re-derived fresh every time the queue is fetched, so it can never drift
// from the real Appointment/QueueItem state the way a background-flagged
// column could.
async function listPossibleNoShows(supabaseClient, clinicId, { doctorId, graceMinutes } = {}) {
  const grace = graceMinutes ?? DEFAULT_NO_SHOW_GRACE_MINUTES;
  const now = Date.now();
  const cutoff = new Date(now - grace * 60_000).toISOString();
  const lookback = new Date(now - NO_SHOW_LOOKBACK_HOURS * 60 * 60_000).toISOString();

  let query = supabaseClient
    .from("Appointment")
    .select("id, doctorId, patientId, timeslot, symptoms")
    .eq("clinicId", clinicId)
    .eq("status", "booked")
    .gte("timeslot", lookback)
    .lt("timeslot", cutoff);
  if (doctorId) query = query.eq("doctorId", doctorId);

  const { data: candidates, error } = await query.order("timeslot", { ascending: true });
  if (error) throw dbErr(`listing possible no-shows: ${error.message}`);
  if (!candidates?.length) return [];

  const ids = candidates.map((c) => c.id);
  const { data: queueRows, error: queueErr } = await supabaseClient.from("QueueItem").select("appointmentId").in("appointmentId", ids);
  if (queueErr) throw dbErr(`checking queue for no-shows: ${queueErr.message}`);
  const checkedInIds = new Set((queueRows ?? []).map((r) => r.appointmentId).filter(Boolean));

  return candidates.filter((c) => !checkedInIds.has(c.id));
}

async function reorder(supabaseClient, { clinicId, ids }) {
  await Promise.all(
    ids.map((id, index) =>
      supabaseClient
        .from("QueueItem")
        .update({ position: index, updatedAt: new Date().toISOString() })
        .eq("id", id)
        .eq("clinicId", clinicId),
    ),
  );
  return listQueue(supabaseClient, clinicId);
}

module.exports = { listQueue, addWalkIn, advance, reorder, notFound, listPossibleNoShows, DEFAULT_NO_SHOW_GRACE_MINUTES };
