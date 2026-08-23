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
const messagingSvc = require("./messaging-service");

const APPOINTMENT_STATUSES = ["booked", "tentative", "cancelled", "completed", "no_show", "blocked"];

function buildAssistantTools({ supabaseClient, nettuClient, twilioClient, clinicId, staffId, staffContext, timezone, reminderDoctor, log }) {
  return {
    list_appointments: tool({
      description:
        "Find appointments by doctor, date range, and/or status. The elemental read tool for anything that refers to a set of existing appointments — call this first whenever you don't already have the specific appointment id(s) you need, before reschedule_appointments/cancel_appointments.",
      inputSchema: z.object({
        doctorId: z.string().optional().describe("Restrict to one doctor. Omit to include every doctor at the clinic."),
        date: z.string().optional().describe("Restrict to exactly one local calendar day, as YYYY-MM-DD."),
        dateFrom: z.string().optional().describe("Local calendar date range start (YYYY-MM-DD), inclusive. Ignored if 'date' is set."),
        dateTo: z.string().optional().describe("Local calendar date range end (YYYY-MM-DD), exclusive. Ignored if 'date' is set."),
        status: z.enum(APPOINTMENT_STATUSES).optional().describe("Restrict to one status. Omit to include every status."),
      }),
      execute: async ({ doctorId, date, dateFrom, dateTo, status }) => {
        let appointments;
        try {
          appointments = await tableSvc.listAppointmentsForClinic(supabaseClient, clinicId, { doctorId, date, dateFrom, dateTo, status });
        } catch (err) {
          return { count: 0, appointments: [], error: err.message };
        }
        // listAppointmentsForClinic doesn't join Patient (the calendar UI
        // that also calls it fetches patients separately) — batch-fetch
        // names just for the ids this call actually returned, rather than
        // changing that shared function's shape. A failure here (e.g. a
        // transient Patient lookup error) shouldn't blank out appointments
        // that were already fetched successfully — fall back to null names.
        const patientIds = [...new Set(appointments.map((a) => a.patientId).filter(Boolean))];
        const namesById = new Map();
        if (patientIds.length) {
          try {
            const { data: patients } = await supabaseClient.from("Patient").select("id, fullName").in("id", patientIds);
            for (const p of patients ?? []) namesById.set(p.id, p.fullName);
          } catch {
            // names stay null below — appointments are still returned
          }
        }
        return {
          count: appointments.length,
          appointments: appointments.map((a) => ({
            id: a.id,
            doctorId: a.doctorId,
            patientName: a.patientId ? (namesById.get(a.patientId) ?? null) : null,
            // The stored timeslot is a bare UTC instant with no offset — live
            // eval caught the model reading it as-is and telling the staff
            // member "01:07 AM (UTC)" instead of their own clinic-local
            // time. availabilitySvc.epochToISO stamps the real offset, same
            // fix formatHumanTime already applies for patient-facing text.
            start: availabilitySvc.epochToISO(new Date(a.timeslot).getTime(), timezone),
            status: a.status,
          })),
        };
      },
    }),

    reschedule_appointments: tool({
      description:
        "Reschedule one or many appointments (up to 20) in a single call — the same tool whether the user means one appointment or many. For more than one, use shiftByDays/shiftByMinutes so each appointment keeps its own original time of day; only pass newStart (an absolute new time) when acting on exactly one appointment id.",
      inputSchema: z.object({
        appointmentIds: z.array(z.string()).min(1).describe("Ids of the appointments to reschedule — from a prior list_appointments call."),
        newStart: z
          .string()
          .optional()
          .describe("Absolute new start time as a full ISO 8601 datetime with offset. Only valid when appointmentIds has exactly one id."),
        shiftByDays: z.number().int().optional().describe("Shift each appointment's own original time by this many days (can be negative)."),
        shiftByMinutes: z.number().int().optional().describe("Shift each appointment's own original time by this many minutes (can be negative)."),
        reason: z.string().optional(),
      }),
      execute: async ({ appointmentIds, newStart, shiftByDays, shiftByMinutes, reason }) => {
        try {
          const result = await appointmentSvc.rescheduleAppointments(
            nettuClient,
            supabaseClient,
            { clinicId, appointmentIds, newStart, shiftByDays, shiftByMinutes, reason, source: "assistant" },
            log,
            twilioClient,
          );
          return result;
        } catch (err) {
          return { succeeded: 0, failed: appointmentIds.length, results: [], error: err.message };
        }
      },
    }),

    cancel_appointments: tool({
      description: "Cancel one or many appointments (up to 20) in a single call — the same tool whether the user means one appointment or many.",
      inputSchema: z.object({
        appointmentIds: z.array(z.string()).min(1).describe("Ids of the appointments to cancel — from a prior list_appointments call."),
        reason: z.string().optional(),
      }),
      execute: async ({ appointmentIds, reason }) => {
        try {
          const result = await appointmentSvc.cancelAppointments(
            nettuClient,
            supabaseClient,
            { clinicId, appointmentIds, reason, source: "assistant" },
            log,
            twilioClient,
          );
          return result;
        } catch (err) {
          return { succeeded: 0, failed: appointmentIds.length, results: [], error: err.message };
        }
      },
    }),

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
          const { slots, timezone, nonWorkingDays } = await availabilitySvc.getAvailableSlots(
            nettuClient,
            supabaseClient,
            { clinicId, doctorId, date },
            log,
          );
          return {
            timezone,
            slots: slots.slice(0, 5).map((s) => ({ start: s.start, end: s.end })),
            // Empty slots is ambiguous on its own — tell the model whether any
            // requested day is closed at the clinic level, so it can say that
            // plainly instead of guessing at "the calendar might be blocked".
            nonWorkingDays: nonWorkingDays?.length ? nonWorkingDays : undefined,
          };
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
        // An empty/whitespace query ILIKE-matches every patient at the
        // clinic (the SQL pattern degenerates to '%%') — silently returning
        // the first one as "the" match would hand back a random patient's
        // history for a malformed/empty query instead of a clean error.
        if (!query?.trim()) return { found: false, matches: [], error: "No search query given." };
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

    list_patient_conversations: tool({
      description:
        "List patient WhatsApp/SMS conversations at this clinic that aren't closed. Use to check for messages needing a reply, or before send_message_to_patient to see if a conversation already exists.",
      inputSchema: z.object({
        onlyUnread: z.boolean().optional().describe("Restrict to conversations with unread messages. Omit to list every open one."),
      }),
      execute: async ({ onlyUnread }) => {
        try {
          const threads = await messagingSvc.listThreads(supabaseClient, clinicId, { staffContext });
          const open = threads.filter((t) => t.status !== "closed" && (!onlyUnread || t.unreadCount > 0));
          const patientIds = [...new Set(open.map((t) => t.patientId).filter(Boolean))];
          const namesById = new Map();
          if (patientIds.length) {
            const { data: patients } = await supabaseClient.from("Patient").select("id, fullName").in("id", patientIds);
            for (const p of patients ?? []) namesById.set(p.id, p.fullName);
          }
          return {
            count: open.length,
            threads: open.slice(0, 20).map((t) => ({
              threadId: t.id,
              patientName: t.patientId ? (namesById.get(t.patientId) ?? null) : null,
              channel: t.channel,
              unreadCount: t.unreadCount,
              lastMessageAt: t.lastMessageAt,
            })),
          };
        } catch (err) {
          return { count: 0, threads: [], error: err.message };
        }
      },
    }),

    send_message_to_patient: tool({
      description:
        "Send a one-off free-text WhatsApp or SMS message to a specific patient. Uses their open WhatsApp conversation if one exists; otherwise falls back to SMS, since a business can only message freely over WhatsApp within a patient-initiated 24h session — a cold WhatsApp message is never attempted here. For a message every patient with an appointment should get automatically (confirmations, reminders, cancellations), that's already handled by the clinic's configured comms workflows — don't use this tool for those.",
      inputSchema: z.object({
        patientName: z.string().describe("The patient's name (or partial name) to search for."),
        message: z.string().min(1).describe("The exact message text to send, in the staff member's own words."),
      }),
      execute: async ({ patientName, message }) => {
        try {
          const patients = await tableSvc.searchPatients(supabaseClient, clinicId, patientName);
          if (!patients?.length) return { sent: false, error: `No patient matching '${patientName}'.` };
          const patient = patients[0];
          if (!patient.contactNumber) return { sent: false, error: `${patient.fullName} has no phone number on file.` };

          const threads = await messagingSvc.listThreads(supabaseClient, clinicId, { staffContext });
          const openWhatsapp = threads.find((t) => t.patientId === patient.id && t.channel === "whatsapp" && t.status !== "closed");
          const thread =
            openWhatsapp ??
            (await messagingSvc.findOrCreateThread(supabaseClient, {
              clinicId,
              patientId: patient.id,
              contactPhone: patient.contactNumber,
              channel: "sms",
            }));

          const sentMessage = await messagingSvc.sendReply(supabaseClient, { clinicId, threadId: thread.id, staffId, body: message, staffContext }, log, twilioClient);
          return { sent: true, channel: thread.channel, patientName: patient.fullName, messageId: sentMessage.id };
        } catch (err) {
          return { sent: false, error: err.message };
        }
      },
    }),

    notify_appointment_delay: tool({
      description:
        "Notify one or more of today's still-upcoming patients that the doctor is running late, by SMS (reliable regardless of WhatsApp session state). Defaults to every patient with a booked/tentative appointment still ahead today for the given doctor — for more than a couple of recipients, confirm the count with the user before calling this, since it sends real messages immediately.",
      inputSchema: z.object({
        doctorId: z
          .string()
          .describe("The doctor's id — use the current doctor's id from context unless the user names someone else."),
        minutesLate: z.number().int().positive().describe("How many minutes late, e.g. 20."),
        patientName: z.string().optional().describe("Notify only this one patient instead of everyone still waiting today."),
      }),
      execute: async ({ doctorId, minutesLate, patientName }) => {
        try {
          // Clinic-local calendar date, not UTC — live eval caught this
          // silently finding zero appointments during the IST evening/night
          // window where the UTC date has already rolled to "tomorrow"
          // relative to a timeslot still stored under today's IST date. Same
          // day-boundary class of bug as the assistant's earlier
          // "already-passed" fix (api-v1-assistant.js) and block_time's.
          //
          // listAppointmentsForClinic's own date filter compares the bare
          // date string directly against the stored (UTC) timeslot, so it
          // can't be handed a timezone-correct "today" directly — a
          // genuinely-IST "today" can be a full UTC calendar day *behind*
          // the timeslot it's stored under (IST is ahead of UTC), so a
          // dateFrom/dateTo of exactly today/tomorrow can undershoot and
          // exclude appointments this fix is specifically trying to include.
          // Net a day on each side with the existing bare-string filter
          // (guaranteed to over-include, never under-include) and narrow to
          // the clinic's actual local day with real UTC instants below.
          const shiftDate = (dateStr, days) => new Date(new Date(`${dateStr}T00:00:00Z`).getTime() + days * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
          const today = new Date().toLocaleDateString("en-CA", { timeZone: timezone });
          const netFrom = shiftDate(today, -1);
          const netTo = shiftDate(today, 2);
          const dayStartMs = new Date(availabilitySvc.localToUtcISO(today, "00:00", timezone)).getTime();
          const dayEndMs = dayStartMs + 24 * 60 * 60 * 1000;

          const [booked, tentative] = await Promise.all([
            tableSvc.listAppointmentsForClinic(supabaseClient, clinicId, { doctorId, dateFrom: netFrom, dateTo: netTo, status: "booked" }),
            tableSvc.listAppointmentsForClinic(supabaseClient, clinicId, { doctorId, dateFrom: netFrom, dateTo: netTo, status: "tentative" }),
          ]);
          let appts = [...booked, ...tentative].filter((a) => {
            const ms = new Date(a.timeslot).getTime();
            return ms > Date.now() && ms >= dayStartMs && ms < dayEndMs;
          });

          if (patientName) {
            const patients = await tableSvc.searchPatients(supabaseClient, clinicId, patientName);
            if (!patients?.length) return { notified: 0, error: `No patient matching '${patientName}'.` };
            appts = appts.filter((a) => a.patientId === patients[0].id);
            if (!appts.length) return { notified: 0, error: `${patients[0].fullName} has no upcoming appointment today with this doctor.` };
          }
          if (!appts.length) return { notified: 0, error: "No upcoming appointments today to notify." };

          const patientIds = [...new Set(appts.map((a) => a.patientId).filter(Boolean))];
          const { data: patientRows } = await supabaseClient.from("Patient").select("id, fullName, contactNumber").in("id", patientIds);
          const byId = new Map((patientRows ?? []).map((p) => [p.id, p]));

          const body = `Running about ${minutesLate} min late today — sorry for the wait, we'll see you as soon as we can.`;
          let notified = 0;
          const failed = [];
          for (const appt of appts) {
            const patient = byId.get(appt.patientId);
            if (!patient?.contactNumber) {
              failed.push(patient?.fullName ?? appt.patientId);
              continue;
            }
            try {
              const thread = await messagingSvc.findOrCreateThread(supabaseClient, {
                clinicId,
                patientId: patient.id,
                contactPhone: patient.contactNumber,
                channel: "sms",
              });
              await messagingSvc.sendReply(supabaseClient, { clinicId, threadId: thread.id, staffId, body, staffContext }, log, twilioClient);
              notified++;
            } catch {
              failed.push(patient.fullName);
            }
          }
          return { notified, failed, totalConsidered: appts.length };
        } catch (err) {
          return { notified: 0, error: err.message };
        }
      },
    }),
  };
}

module.exports = { buildAssistantTools };
