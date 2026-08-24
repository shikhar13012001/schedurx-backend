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

function systemPromptFor({ clinic, patient, timezone, scope = "general" }) {
  const now = new Date();
  const todayLocal = now.toLocaleDateString("en-CA", { timeZone: timezone });
  const nowTimeLocal = now.toLocaleTimeString("en-GB", {
    timeZone: timezone,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });

  const lines = [
    `You are ${clinic?.name ?? "the clinic"}'s WhatsApp assistant, talking directly with a patient.`,
    patient?.fullName ? `The patient's name on file is ${patient.fullName}.` : "This patient hasn't given their name yet.",
    `Today is ${todayLocal}, current time ${nowTimeLocal} (24-hour), in the clinic's timezone (${timezone}).`,
    // Narrowed, not loosened (Phase 6): still never a bare name as proof of
    // identity — only confirm_identity, and only from a phone number or
    // booking id the caller actually typed, can change whose record you use.
    "You are currently set up to act on the person named above. If the caller says this conversation is actually " +
      "about someone else (e.g. 'this is for my mother', 'I'm booking for my son') or quotes a booking id from a " +
      "confirmation message, call confirm_identity with the exact phone number or booking id they just typed — " +
      "never with a name alone, and never with a number or id you're guessing at. Until they give you one of those, " +
      "keep acting on the person named above. If they want to book a brand-new appointment, ask a medical question, " +
      "complain, or ask for anything else you don't have a tool for, use escalate_to_staff and tell them a staff " +
      "member will follow up.",
    `Times returned by tools are already in the clinic's local time (${timezone}) with an explicit offset — state ` +
      "them as-is, don't relabel them as UTC or convert them yourself.",
    "Your tools are elemental building blocks — get_my_appointments finds which appointment(s) a request is about " +
      "(it defaults to upcoming ones, or pass status/dateFrom/dateTo to ask about something else, like past or " +
      "cancelled visits)" +
      (scope === "booking"
        ? "."
        : ", and reschedule_my_appointments/cancel_my_appointments act on one or many appointmentIds from that " +
          "result — the same tool either way, not a different one for 'my appointment' vs 'all my appointments'."),
  ];

  if (scope === "booking") {
    // Booking-scoped threads (Phase 4) don't get reschedule/cancel tools at
    // all — tell the model plainly rather than let it discover that by
    // trying and failing, which would confuse the reply it gives.
    lines.push(
      "This conversation is about one specific booking, not the patient's whole schedule — you can look up its " +
        "details and the patient's visit history, but you don't have reschedule or cancel tools here. If they want " +
        "to reschedule or cancel, use escalate_to_staff and tell them a staff member will follow up, or point them " +
        "to their general conversation with the clinic if one exists.",
    );
  } else {
    lines.push(
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
    );
  }

  lines.push(
    "Keep replies short (1-3 sentences), warm, and concrete — confirm exactly what you did with the real date/time " +
      "(or for a bulk action, how many succeeded and which ones didn't), or ask one brief clarifying question if " +
      "something's ambiguous.",
    "Never claim to have done something without actually calling the matching tool first.",
    "ALWAYS end your turn with a short text reply to the patient, even after calling one or more tools — never end " +
      "the turn on a tool call alone. If a tool failed, say so plainly in plain language, don't just go silent.",
  );

  return lines.join("\n");
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

    // Mutable (Phase 6) — confirm_identity can repair this mid-conversation
    // if the phone-based resolution attached the wrong patient (e.g. a
    // shared family phone). Every tool reads context.patientId at call time,
    // not this initial value, so a correction takes effect for the rest of
    // this same tool-calling loop, not just future messages.
    const context = { patientId: patient.id };
    const scope = thread.scope ?? "general";

    const tools = buildPatientAgentTools({
      supabaseClient,
      nettuClient,
      twilioClient,
      clinicId: clinic.id,
      context,
      threadId: thread.id,
      doctors,
      timezone,
      scope,
      log,
    });

    const result = await generateText({
      model: assistantModel,
      system: systemPromptFor({ clinic, patient, timezone, scope }),
      messages,
      tools,
      // Higher than the staff assistant's stepCountIs(6) — a reschedule alone
      // can take 3+ tool calls (find the appointment, find slots, execute the
      // reschedule) before a final text reply, and running out of steps
      // mid-flow leaves the model with zero budget left to produce any
      // closing text at all, not just an unfinished action.
      stopWhen: stepCountIs(8),
    });

    const text = result.text?.trim();
    if (text) return text;

    // Phase 8's live eval surfaced this: despite the system prompt's
    // explicit "ALWAYS end your turn with a short text reply" instruction,
    // the model sometimes ends its turn right after a tool call with no
    // closing text at all — no error, no thrown exception, the tool call
    // itself (e.g. escalate_to_staff) genuinely succeeded, just nothing to
    // say about it. Previously this fell through to `|| null`, which
    // webhooks-twilio.js turns into a truly empty TwiML reply — the patient
    // sees literally nothing, indistinguishable from the bot being broken.
    // A generic acknowledgment is always better than silence here; logged
    // (unlike the old silent null) so this is visible for future prompt
    // tuning rather than invisible.
    log?.warn(
      { clinicId: clinic?.id, threadId: thread?.id, finishReason: result.finishReason },
      "[whatsappAgentSvc] model ended its turn with no closing text — using a generic fallback instead of a silent reply",
    );
    return "Got it — thanks for your message! If you don't hear back shortly, a staff member will follow up.";
  } catch (err) {
    log?.error({ err, clinicId: clinic?.id, threadId: thread?.id }, "[whatsappAgentSvc] failed to generate a reply");
    return null;
  }
}

module.exports = { respondToPatientMessage };
