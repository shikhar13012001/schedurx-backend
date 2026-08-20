// Tool definitions for the WhatsApp patient agent (whatsapp-agent-service.js,
// invoked from webhooks-twilio.js's /whatsapp-inbound). Mirrors
// assistant-tools.js's shape — each tool wraps an existing, already-tested
// service function — but with a stricter closure than the staff assistant:
// the caller here is unauthenticated beyond the phone number Twilio's
// signature already verified, so clinicId/patientId/threadId are captured by
// closure and NEVER taken from the model's tool-call arguments, and no tool
// accepts a patient identifier at all (contrast assistant-tools.js's
// find_patient_history, which searches any patient by name for a logged-in
// staff member). Every tool touching a specific appointmentId re-verifies
// server-side that it belongs to this clinicId+patientId before acting —
// defense against a hallucinated or guessed id.

const { z } = require("zod");
const { tool } = require("ai");
const appointmentSvc = require("./appointment-service");
const availabilitySvc = require("./availability-service");
const tableSvc = require("./table-service");
const visitSvc = require("./visit-service");
const messagingSvc = require("./messaging-service");

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

function buildPatientAgentTools({
  supabaseClient,
  nettuClient,
  twilioClient,
  clinicId,
  patientId,
  threadId,
  doctors,
  timezone,
  log,
}) {
  const doctorNameFor = (doctorId) => doctors?.find((d) => d.id === doctorId)?.fullName ?? null;
  // The stored timeslot is a naive UTC-ish timestamp (see availability-service.js's
  // epochToISO/normalizeAppointment precedent) — converted to the clinic's local
  // time with an explicit offset here so the model states the time the patient
  // actually experiences, not a bare UTC-looking string it might read as UTC.
  const localTime = (isoTimeslot) =>
    timezone && isoTimeslot ? availabilitySvc.epochToISO(new Date(isoTimeslot).getTime(), timezone) : isoTimeslot;

  return {
    get_my_appointments: tool({
      description: "List the caller's own upcoming (not cancelled) appointments at this clinic.",
      inputSchema: z.object({}),
      execute: async () => {
        const appts = await tableSvc.listUpcomingAppointmentsForPatient(supabaseClient, clinicId, patientId);
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
        const visits = await visitSvc.listVisitsForPatient(supabaseClient, clinicId, patientId);
        return {
          visits: visits
            .slice(0, 5)
            .map((v) => ({ date: v.visitDate, symptoms: v.symptoms, diagnosis: v.diagnosis, note: v.note })),
        };
      },
    }),

    find_reschedule_slots: tool({
      description: "Find open slots to reschedule one of the caller's own appointments to.",
      inputSchema: z.object({
        appointmentId: z.string().describe("An appointmentId from get_my_appointments."),
        date: z.string().optional().describe("Restrict the search to one day, as YYYY-MM-DD. Omit to search broadly."),
      }),
      execute: async ({ appointmentId, date }) => {
        const appt = await assertOwnedAppointment(supabaseClient, clinicId, patientId, appointmentId);
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

    reschedule_my_appointment: tool({
      description: "Reschedule one of the caller's own appointments to a new time the caller has agreed to.",
      inputSchema: z.object({
        appointmentId: z.string().describe("An appointmentId from get_my_appointments."),
        date: z
          .string()
          .describe("The local calendar date to reschedule to, as YYYY-MM-DD, from find_reschedule_slots."),
        time: z
          .string()
          .describe("The local 24-hour clock time to reschedule to, as HH:MM, from find_reschedule_slots."),
      }),
      // date/time, never a raw ISO timestamp from the model — the model is
      // unreliable at UTC-offset arithmetic (see find_reschedule_slots), so
      // conversion happens here via the same deterministic helper
      // assistant-tools.js's block_time/add_task already rely on.
      execute: async ({ appointmentId, date, time }) => {
        const appt = await assertOwnedAppointment(supabaseClient, clinicId, patientId, appointmentId);
        if (!appt) return notOwned();
        const newStart = availabilitySvc.localToUtcISO(date, time, timezone);
        try {
          const result = await appointmentSvc.rescheduleAppointment(
            nettuClient,
            supabaseClient,
            {
              appointmentId,
              clinicId,
              doctorId: appt.doctorId,
              newStart,
              reason: "Rescheduled via WhatsApp",
              source: "patient_whatsapp",
            },
            log,
            twilioClient,
          );
          return { ok: true, ...result };
        } catch (err) {
          return { ok: false, error: err.message };
        }
      },
    }),

    cancel_my_appointment: tool({
      description: "Cancel one of the caller's own appointments.",
      inputSchema: z.object({
        appointmentId: z.string().describe("An appointmentId from get_my_appointments."),
        reason: z.string().optional().describe("Short reason the caller gave, if any."),
      }),
      execute: async ({ appointmentId, reason }) => {
        const appt = await assertOwnedAppointment(supabaseClient, clinicId, patientId, appointmentId);
        if (!appt) return notOwned();
        try {
          const result = await appointmentSvc.cancelAppointment(
            nettuClient,
            supabaseClient,
            { appointmentId, clinicId, reason, source: "patient_whatsapp" },
            log,
            twilioClient,
          );
          return { ok: true, ...result };
        } catch (err) {
          return { ok: false, error: err.message };
        }
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
}

module.exports = { buildPatientAgentTools };
