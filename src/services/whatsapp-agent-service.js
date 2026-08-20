// Orchestrates the WhatsApp patient agent — the AI-handled counterpart to
// staff-facing Ask ScheduRx (api-v1-assistant.js), invoked from
// webhooks-twilio.js's /whatsapp-inbound instead of a browser chat. Same `ai`
// SDK tool-calling primitives, but generateText (one-shot) instead of
// streamText (no SSE consumer here — Twilio just wants a final reply string),
// and a stricter, phone-verified-identity-only tool surface
// (whatsapp-agent-tools.js).
//
// Never throws out to the caller — a model/tool failure must fall back to
// webhooks-twilio.js's existing empty-TwiML-reply behavior, not break inbound
// message logging or crash the webhook.

const { generateText, stepCountIs } = require("ai");
const tableSvc = require("./table-service");
const clinicSvc = require("./clinic-service");
const messagingSvc = require("./messaging-service");
const { buildPatientAgentTools } = require("./whatsapp-agent-tools");

function systemPromptFor({ clinic, patient, timezone }) {
  const now = new Date();
  const todayLocal = now.toLocaleDateString("en-CA", { timeZone: timezone });
  const nowTimeLocal = now.toLocaleTimeString("en-GB", {
    timeZone: timezone,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });

  return [
    `You are ${clinic?.name ?? "the clinic"}'s WhatsApp assistant, talking directly with a patient.`,
    patient?.fullName ? `The patient's name on file is ${patient.fullName}.` : "This patient hasn't given their name yet.",
    `Today is ${todayLocal}, current time ${nowTimeLocal} (24-hour), in the clinic's timezone (${timezone}).`,
    "You can only ever act on the person you're already talking to — never ask for or accept a different name/patient " +
      "id as if switching whose record to use. If they want to book a brand-new appointment, ask a medical question, " +
      "complain, or ask for anything else you don't have a tool for, use escalate_to_staff and tell them a staff " +
      "member will follow up.",
    `Times returned by tools are already in the clinic's local time (${timezone}) with an explicit offset — state ` +
      "them as-is, don't relabel them as UTC or convert them yourself.",
    "Your tools are elemental building blocks — get_my_appointments finds which appointment(s) a request is about " +
      "(it defaults to upcoming ones, or pass status/dateFrom/dateTo to ask about something else, like past or " +
      "cancelled visits), and reschedule_my_appointments/cancel_my_appointments act on one or many appointmentIds " +
      "from that result — the same tool either way, not a different one for 'my appointment' vs 'all my appointments'.",
    "For exactly ONE appointment: when they give a reschedule preference (a day, a time of day, or 'whatever's " +
      "open'), call find_reschedule_slots, then just pick a matching slot yourself and call " +
      "reschedule_my_appointments right away with that one id — don't make them pick from a list unless their " +
      "request was genuinely ambiguous. Pass the exact date/time fields a slot gave you — never compute or retype " +
      "them yourself.",
    "For MORE THAN ONE appointment (e.g. 'move all my bookings to tomorrow', 'cancel everything I have this week'): " +
      "call get_my_appointments first, then say out loud in your reply which specific appointments (doctor + date/time " +
      "for each) you're about to change, and wait for the patient to clearly say yes before calling " +
      "reschedule_my_appointments/cancel_my_appointments with more than one id in the same turn. Never bulk-act on " +
      "more than one appointment without that explicit confirmation having already happened in the conversation — " +
      "this matters even if their request sounded confident, since a mistake here changes real appointments with no " +
      "one else reviewing it. Use shiftByDays/shiftByMinutes for a bulk reschedule so each appointment keeps its own " +
      "original time of day.",
    "Keep replies short (1-3 sentences), warm, and concrete — confirm exactly what you did with the real date/time " +
      "(or for a bulk action, how many succeeded and which ones didn't), or ask one brief clarifying question if " +
      "something's ambiguous.",
    "Never claim to have done something without actually calling the matching tool first.",
    "ALWAYS end your turn with a short text reply to the patient, even after calling one or more tools — never end " +
      "the turn on a tool call alone. If a tool failed, say so plainly in plain language, don't just go silent.",
  ].join("\n");
}

async function respondToPatientMessage({ supabaseClient, nettuClient, twilioClient, assistantModel, clinic, patient, thread }, log) {
  try {
    const { timezone } = clinicSvc.getSchedulingRules(clinic ?? {});
    const [doctors, history] = await Promise.all([
      tableSvc.listActiveDoctors(supabaseClient, clinic.id),
      messagingSvc.listMessages(supabaseClient, thread.id),
    ]);

    const messages = history.slice(-10).map((m) => ({
      role: m.direction === "inbound" ? "user" : "assistant",
      content: m.body ?? "",
    }));

    const tools = buildPatientAgentTools({
      supabaseClient,
      nettuClient,
      twilioClient,
      clinicId: clinic.id,
      patientId: patient.id,
      threadId: thread.id,
      doctors,
      timezone,
      log,
    });

    const result = await generateText({
      model: assistantModel,
      system: systemPromptFor({ clinic, patient, timezone }),
      messages,
      tools,
      // Higher than the staff assistant's stepCountIs(6) — a reschedule alone
      // can take 3+ tool calls (find the appointment, find slots, execute the
      // reschedule) before a final text reply, and running out of steps
      // mid-flow leaves the model with zero budget left to produce any
      // closing text at all, not just an unfinished action.
      stopWhen: stepCountIs(8),
    });

    return result.text?.trim() || null;
  } catch (err) {
    log?.error({ err, clinicId: clinic?.id, threadId: thread?.id }, "[whatsappAgentSvc] failed to generate a reply");
    return null;
  }
}

module.exports = { respondToPatientMessage };
