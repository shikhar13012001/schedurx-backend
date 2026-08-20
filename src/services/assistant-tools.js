// Tool definitions for the "Ask ScheduRx" in-app assistant (POST /api/v1/assistant).
// Each tool wraps an existing, already-tested service function — no new
// business logic lives here. clinicId/staffId are captured via closure from
// the authenticated request context, never taken from the model's tool-call
// arguments, so the model can't act outside its own clinic no matter what
// it's asked to do.

const { z } = require("zod");
const { tool } = require("ai");
const appointmentSvc = require("./appointment-service");
const availabilitySvc = require("./availability-service");
const tableSvc = require("./table-service");
const visitSvc = require("./visit-service");
const taskSvc = require("./task-service");

function buildAssistantTools({ supabaseClient, nettuClient, clinicId, staffId, timezone, reminderDoctor, log }) {
  return {
    block_time: tool({
      description:
        "Block a window on a doctor's calendar so no new appointments can land in it. Use when the staff member wants to mark a doctor (themselves or someone named) unavailable.",
      inputSchema: z.object({
        doctorId: z
          .string()
          .describe("The doctor's id — use the current doctor's id from context unless the user names someone else."),
        date: z
          .string()
          .describe(
            "The local calendar date at the clinic to block, as YYYY-MM-DD — never adjust this for timezone yourself, the tool does that.",
          ),
        time: z
          .string()
          .describe(
            "The local 24-hour clock time at the clinic the block starts, as HH:MM (e.g. '16:00' for 4pm) — never adjust this for timezone yourself, the tool does that.",
          ),
        minutes: z.number().int().positive().describe("Duration of the block, in minutes."),
        reason: z.string().optional().describe("Short reason, e.g. 'Hospital rounds'."),
      }),
      execute: async ({ doctorId, date, time, minutes, reason }) => {
        const start = new Date(availabilitySvc.localToUtcISO(date, time, timezone));
        if (Number.isNaN(start.getTime())) {
          return { blocked: false, error: "That date/time couldn't be parsed." };
        }
        const end = new Date(start.getTime() + minutes * 60_000);
        try {
          const appointment = await appointmentSvc.bookAppointment(
            nettuClient,
            supabaseClient,
            {
              clinicId,
              doctorId,
              patientId: null,
              start: start.toISOString(),
              end: end.toISOString(),
              notes: reason ?? "Blocked via assistant",
              status: "blocked",
              source: "assistant",
            },
            log,
          );
          return {
            blocked: true,
            doctorId,
            start: start.toISOString(),
            end: end.toISOString(),
            appointmentId: appointment.id,
          };
        } catch (err) {
          return { blocked: false, error: err.message };
        }
      },
    }),

    find_next_free_slot: tool({
      description: "Find the next open bookable slot(s) on a doctor's calendar.",
      inputSchema: z.object({
        doctorId: z
          .string()
          .describe("The doctor's id — use the current doctor's id from context unless the user names someone else."),
        date: z
          .string()
          .optional()
          .describe(
            "Restrict the search to one day, as YYYY-MM-DD. Omit to search the full booking window starting today.",
          ),
      }),
      execute: async ({ doctorId, date }) => {
        try {
          const { slots, timezone } = await availabilitySvc.getAvailableSlots(
            nettuClient,
            supabaseClient,
            { clinicId, doctorId, date },
            log,
          );
          return { timezone, slots: slots.slice(0, 5).map((s) => ({ start: s.start, end: s.end })) };
        } catch (err) {
          return { slots: [], error: err.message };
        }
      },
    }),

    find_patient_history: tool({
      description: "Search for a patient by name and return their visit history.",
      inputSchema: z.object({
        query: z.string().describe("Patient name (or partial name) to search for."),
      }),
      execute: async ({ query }) => {
        const patients = await tableSvc.searchPatients(supabaseClient, clinicId, query);
        if (!patients?.length) return { found: false, matches: [] };
        const top = patients[0];
        const visits = await visitSvc.listVisitsForPatient(supabaseClient, clinicId, top.id);
        return {
          found: true,
          patient: { id: top.id, name: top.fullName, age: top.age, gender: top.gender },
          otherMatches: patients.slice(1, 4).map((p) => p.fullName),
          visits: visits
            .slice(0, 5)
            .map((v) => ({ date: v.visitDate, symptoms: v.symptoms, diagnosis: v.diagnosis, note: v.note })),
        };
      },
    }),

    add_task: tool({
      description:
        "Add a personal to-do/reminder task for the staff member. Only call block_time alongside this when the user explicitly asks to block/reserve calendar time for the activity — most tasks (calls, follow-ups, admin) shouldn't touch the calendar.",
      inputSchema: z.object({
        title: z.string().describe("The task text."),
        dueDate: z
          .string()
          .optional()
          .describe(
            "Local calendar due date at the clinic, as YYYY-MM-DD, if the user gave one — never adjust this for timezone yourself.",
          ),
        dueTime: z
          .string()
          .optional()
          .describe(
            "Local 24-hour clock due time at the clinic, as HH:MM, if the user gave one — never adjust this for timezone yourself. Omit if only a date was given.",
          ),
      }),
      execute: async ({ title, dueDate, dueTime }) => {
        const dueAt = dueDate ? availabilitySvc.localToUtcISO(dueDate, dueTime ?? "09:00", timezone) : undefined;
        const task = await taskSvc.createTask(supabaseClient, {
          clinicId,
          createdByStaffId: staffId,
          title,
          dueAt,
          viaAI: true,
          nettuClient,
          doctor: reminderDoctor,
          log,
        });
        return { added: true, taskId: task.id, title: task.title };
      },
    }),
  };
}

module.exports = { buildAssistantTools };
