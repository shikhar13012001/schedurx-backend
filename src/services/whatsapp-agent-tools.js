// Tool definitions for the WhatsApp patient agent (whatsapp-agent-service.js,
// invoked from webhooks-twilio.js's /whatsapp-inbound). Mirrors
// assistant-tools.js's shape — each tool wraps an existing, already-tested
// service function — but with a stricter closure than the staff assistant:
// the caller here is unauthenticated beyond the phone number Twilio's
// signature already verified, so clinicId/threadId are captured by closure
// and NEVER taken from the model's tool-call arguments, and no tool accepts
// a patient identifier directly (contrast assistant-tools.js's
// find_patient_history, which searches any patient by name for a logged-in
// staff member) — the one exception is confirm_identity (Phase 6), which
// exists specifically to *correct* identity, and only from a phone number or
// booking id the caller just typed, never a model-invented one. Every tool
// touching a specific appointmentId re-verifies server-side that it belongs
// to this clinicId+patientId before acting — defense against a hallucinated
// or guessed id.
//
// `context` (Phase 6) is a mutable { patientId } object, not a plain value —
// every tool below reads context.patientId at execute() time, not at
// buildPatientAgentTools() call time, so confirm_identity's correction takes
// effect immediately for every tool call still to come in the same
// tool-calling loop, not just future messages.

const { z } = require("zod");
const { tool } = require("ai");
const appointmentSvc = require("./appointment-service");
const availabilitySvc = require("./availability-service");
const tableSvc = require("./table-service");
const visitSvc = require("./visit-service");
const messagingSvc = require("./messaging-service");

const APPOINTMENT_STATUSES = ["booked", "tentative", "cancelled", "completed", "no_show", "blocked"];
const MAX_BULK_APPOINTMENTS = 10; // lower than the staff assistant's 20 — a patient's own list is always small

function notOwned() {
  return { ok: false, error: "That appointment doesn't belong to this conversation." };
}

async function assertOwnedAppointment(supabaseClient, clinicId, patientId, appointmentId) {
  const { data: appt, error } = await supabaseClient
    .from("Appointment")
    .select("*")
    .eq("id", appointmentId)
    .maybeSingle();
  if (error || !appt || appt.clinicId !== clinicId || appt.patientId !== patientId) return null;
  return appt;
}

// scope: "general" | "booking" (Thread.scope, Phase 4) — a booking-scoped
// thread gets a narrower tool set (no reschedule/cancel/find_reschedule_slots
// — those stay general-thread-only, per the plan's design) since it exists
// to talk about one specific appointment, not to manage the patient's whole
// schedule.
function buildPatientAgentTools({
  supabaseClient,
  nettuClient,
  twilioClient,
  clinicId,
  context,
  threadId,
  doctors,
  timezone,
  scope = "general",
  log,
}) {
  const doctorNameFor = (doctorId) => doctors?.find((d) => d.id === doctorId)?.fullName ?? null;
  // The stored timeslot is a naive UTC-ish timestamp (see availability-service.js's
  // epochToISO/normalizeAppointment precedent) — converted to the clinic's local
  // time with an explicit offset here so the model states the time the patient
  // actually experiences, not a bare UTC-looking string it might read as UTC.
  const localTime = (isoTimeslot) =>
    timezone && isoTimeslot ? availabilitySvc.epochToISO(new Date(isoTimeslot).getTime(), timezone) : isoTimeslot;

  const tools = {
    confirm_identity: tool({
      description:
        "Use ONLY when the caller explicitly gives you a phone number or booking id that's different from who you're currently talking to — e.g. 'Actually this is for my mother, her number is ...', or they quote a booking id from a confirmation message — to correct which patient record this conversation is about. Never call this from a name alone, and never invent or guess a phone number or booking id the caller didn't literally just type; if you're not sure, ask them to type it instead of calling this speculatively.",
      inputSchema: z.object({
        phone: z.string().optional().describe("The exact phone number the caller just typed, if they gave one."),
        appointmentId: z.string().optional().describe("The exact booking id the caller just typed (e.g. from a confirmation message), if they gave one."),
      }),
      execute: async ({ phone, appointmentId }) => {
        if (!phone && !appointmentId) return { ok: false, error: "Provide the phone number or booking id the caller actually typed." };

        let resolvedPatientId = null;
        if (appointmentId) {
          const appt = await tableSvc.getAppointmentById(supabaseClient, clinicId, appointmentId);
          if (!appt) return { ok: false, error: "No booking found with that id at this clinic." };
          resolvedPatientId = appt.patientId;
        } else {
          const patient = await tableSvc.findPatientByExactPhone(supabaseClient, clinicId, phone);
          if (!patient) return { ok: false, error: "No patient found with that exact phone number at this clinic." };
          resolvedPatientId = patient.id;
        }
        if (!resolvedPatientId) return { ok: false, error: "Couldn't resolve a patient from that." };

        context.patientId = resolvedPatientId;
        try {
          await supabaseClient
            .from("Thread")
            .update({ confirmedPatientId: resolvedPatientId, updatedAt: new Date().toISOString() })
            .eq("id", threadId);
        } catch (err) {
          log?.warn({ err, threadId }, "[whatsappAgentTools] confirm_identity: failed to persist onto Thread — correction only lasts this turn");
        }

        const { data: patientRow } = await supabaseClient.from("Patient").select("fullName").eq("id", resolvedPatientId).maybeSingle();
        return { ok: true, confirmed: true, patientName: patientRow?.fullName ?? null };
      },
    }),

    get_my_appointments: tool({
      description:
        "List the caller's own appointments at this clinic. With no arguments, returns upcoming (not cancelled) ones — the usual case. Pass status/dateFrom/dateTo to ask about something else instead (past visits, cancelled ones, a specific day), not to narrow the default further.",
      inputSchema: z.object({
        status: z.enum(APPOINTMENT_STATUSES).optional().describe("Only appointments in this status. Omit for the default 'upcoming, not cancelled' behavior."),
        dateFrom: z.string().optional().describe("ISO datetime lower bound, inclusive. Omit for the default 'from now on'."),
        dateTo: z.string().optional().describe("ISO datetime upper bound, exclusive."),
      }),
      execute: async ({ status, dateFrom, dateTo }) => {
        const appts = await tableSvc.listUpcomingAppointmentsForPatient(supabaseClient, clinicId, context.patientId, { status, dateFrom, dateTo });
        return {
          appointments: appts.map((a) => ({
            appointmentId: a.id,
            doctorName: doctorNameFor(a.doctorId),
            timeslot: localTime(a.timeslot),
            status: a.status,
          })),
        };
      },
    }),

    get_my_visit_history: tool({
      description: "Look up the caller's past visit history (diagnoses, notes) at this clinic.",
      inputSchema: z.object({}),
      execute: async () => {
        const visits = await visitSvc.listVisitsForPatient(supabaseClient, clinicId, context.patientId);
        return {
          visits: visits
            .slice(0, 5)
            .map((v) => ({ date: v.visitDate, symptoms: v.symptoms, diagnosis: v.diagnosis, note: v.note })),
        };
      },
    }),

    escalate_to_staff: tool({
      description:
        "Hand this conversation off to clinic staff — use for anything you can't do yourself: booking a new " +
        "appointment, a medical question, a complaint, or anything you're not confident about.",
      inputSchema: z.object({
        reason: z.string().optional().describe("Short reason for the handoff, for the staff member's benefit."),
      }),
      execute: async () => {
        await messagingSvc.escalate(supabaseClient, clinicId, threadId);
        return { ok: true, escalated: true };
      },
    }),
  };

  if (scope === "booking") return tools;

  Object.assign(tools, {
    find_reschedule_slots: tool({
      description: "Find open slots to reschedule one of the caller's own appointments to.",
      inputSchema: z.object({
        appointmentId: z.string().describe("An appointmentId from get_my_appointments."),
        date: z.string().optional().describe("Restrict the search to one day, as YYYY-MM-DD. Omit to search broadly."),
      }),
      execute: async ({ appointmentId, date }) => {
        const appt = await assertOwnedAppointment(supabaseClient, clinicId, context.patientId, appointmentId);
        if (!appt) return notOwned();
        try {
          const { slots, timezone } = await availabilitySvc.getAvailableSlots(
            nettuClient,
            supabaseClient,
            { clinicId, doctorId: appt.doctorId, date },
            log,
          );
          // date/time (not just the ISO `start`) so reschedule_my_appointment never
          // has to parse or re-derive a timestamp itself — see that tool's comment
          // for why: LLMs are unreliable at UTC-offset arithmetic (same lesson
          // already learned in assistant-tools.js's block_time/add_task).
          return {
            ok: true,
            timezone,
            slots: slots.slice(0, 5).map((s) => ({ date: s.start.slice(0, 10), time: s.start.slice(11, 16) })),
          };
        } catch (err) {
          return { ok: false, error: err.message };
        }
      },
    }),

    reschedule_my_appointments: tool({
      description:
        "Reschedule one or more of the caller's own appointments (up to 10) to a new time the caller has EXPLICITLY agreed to. For more than one appointmentId, you must have already listed the affected appointments to the caller in this conversation and gotten a clear yes — never bulk-reschedule from an ambiguous request. For a single appointment, pass date/time from find_reschedule_slots. For more than one, use shiftByDays/shiftByMinutes instead so each one keeps its own original time of day.",
      inputSchema: z.object({
        appointmentIds: z.array(z.string()).min(1).max(MAX_BULK_APPOINTMENTS).describe("appointmentId(s) from get_my_appointments."),
        date: z.string().optional().describe("Local calendar date to reschedule to, as YYYY-MM-DD, from find_reschedule_slots. Only valid with exactly one id."),
        time: z.string().optional().describe("Local 24-hour clock time to reschedule to, as HH:MM, from find_reschedule_slots. Only valid with exactly one id."),
        shiftByDays: z.number().int().optional().describe("For more than one appointmentId: shift each one's own original time by this many days (e.g. 1 for 'move to tomorrow')."),
        shiftByMinutes: z.number().int().optional().describe("For more than one appointmentId: shift each one's own original time by this many minutes."),
      }),
      // date/time, never a raw ISO timestamp from the model — the model is
      // unreliable at UTC-offset arithmetic (see find_reschedule_slots), so
      // conversion happens here via the same deterministic helper
      // assistant-tools.js's block_time/add_task already rely on.
      execute: async ({ appointmentIds, date, time, shiftByDays, shiftByMinutes }) => {
        if (appointmentIds.length > 1 && (date || time)) {
          return { ok: false, error: "date/time only apply to a single appointmentId — use shiftByDays/shiftByMinutes for more than one." };
        }
        const results = [];
        for (const appointmentId of appointmentIds) {
          const appt = await assertOwnedAppointment(supabaseClient, clinicId, context.patientId, appointmentId);
          if (!appt) {
            results.push({ appointmentId, ...notOwned() });
            continue;
          }
          try {
            let newStart;
            if (date && time) {
              newStart = availabilitySvc.localToUtcISO(date, time, timezone);
            } else {
              const shiftMs = (shiftByDays ?? 0) * 24 * 60 * 60 * 1000 + (shiftByMinutes ?? 0) * 60 * 1000;
              if (!appt.timeslot || shiftMs === 0) throw Object.assign(new Error("Provide date+time, or a non-zero shiftByDays/shiftByMinutes"), {});
              newStart = new Date(new Date(appt.timeslot).getTime() + shiftMs).toISOString();
            }
            const result = await appointmentSvc.rescheduleAppointment(
              nettuClient,
              supabaseClient,
              { appointmentId, clinicId, doctorId: appt.doctorId, newStart, reason: "Rescheduled via WhatsApp", source: "patient_whatsapp" },
              log,
              twilioClient,
            );
            results.push({ appointmentId, ok: true, ...result });
          } catch (err) {
            results.push({ appointmentId, ok: false, error: err.message });
          }
        }
        return { succeeded: results.filter((r) => r.ok).length, failed: results.filter((r) => !r.ok).length, results };
      },
    }),

    cancel_my_appointments: tool({
      description:
        "Cancel one or more of the caller's own appointments (up to 10). For more than one appointmentId, you must have already listed the affected appointments to the caller in this conversation and gotten a clear yes — never bulk-cancel from an ambiguous request.",
      inputSchema: z.object({
        appointmentIds: z.array(z.string()).min(1).max(MAX_BULK_APPOINTMENTS).describe("appointmentId(s) from get_my_appointments."),
        reason: z.string().optional().describe("Short reason the caller gave, if any."),
      }),
      execute: async ({ appointmentIds, reason }) => {
        const results = [];
        for (const appointmentId of appointmentIds) {
          const appt = await assertOwnedAppointment(supabaseClient, clinicId, context.patientId, appointmentId);
          if (!appt) {
            results.push({ appointmentId, ...notOwned() });
            continue;
          }
          try {
            const result = await appointmentSvc.cancelAppointment(
              nettuClient,
              supabaseClient,
              { appointmentId, clinicId, reason, source: "patient_whatsapp" },
              log,
              twilioClient,
            );
            results.push({ appointmentId, ok: true, ...result });
          } catch (err) {
            results.push({ appointmentId, ok: false, error: err.message });
          }
        }
        return { succeeded: results.filter((r) => r.ok).length, failed: results.filter((r) => !r.ok).length, results };
      },
    }),
  });

  return tools;
}

module.exports = { buildPatientAgentTools };
