// POST /api/v1/assistant — the "Ask ScheduRx" in-app chat agent. Streams a
// UI-message SSE response (consumed by @ai-sdk/react's useChat on the
// frontend) and can call a small set of tools (assistant-tools.js) that wrap
// existing, already-tested service functions. Mounted only when the AI SDK
// model is configured (see buildAssistantModel() in server.js) — same
// whole-subsystem gate pattern as /api/v1/ai (see api-v1.js).

const { Router } = require("express");
const { streamText, convertToModelMessages, stepCountIs, smoothStream } = require("ai");
const { ok, fail } = require("../lib/response-envelope");
const tableSvc = require("../services/table-service");
const clinicSvc = require("../services/clinic-service");
const { buildAssistantTools } = require("../services/assistant-tools");

// The model has no built-in sense of "now", and LLMs are unreliable at doing
// UTC-offset arithmetic in their head even when told the current time — that
// was the actual root cause of block/task times landing on the wrong day or
// hour. So instead of asking the model to produce a UTC instant itself, the
// tools (assistant-tools.js) take a plain local date + 24h time and convert
// deterministically via availabilitySvc.localToUtcISO. This prompt just needs
// to give the model today's date and current time as plain, copyable values.
function systemPromptFor({ role, doctors, defaultDoctorId, timezone }) {
  const roster = doctors.length
    ? doctors.map((d) => `${d.id} — Dr. ${d.fullName}`).join("\n")
    : "(no doctors on file yet)";
  const defaultDoctor = doctors.find((d) => d.id === defaultDoctorId);
  const now = new Date();
  const todayLocal = now.toLocaleDateString("en-CA", { timeZone: timezone }); // YYYY-MM-DD
  const nowTimeLocal = now.toLocaleTimeString("en-GB", {
    timeZone: timezone,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }); // HH:MM
  const nowWeekday = now.toLocaleDateString("en-IN", { timeZone: timezone, weekday: "long" });

  return [
    "You are ScheduRx, an AI assistant embedded in a clinic-operations dashboard.",
    `The staff member you're talking to has the role: ${role}.`,
    `Today's date at the clinic is ${todayLocal} (a ${nowWeekday}), and the current local time is ${nowTimeLocal} (24-hour), in the clinic's timezone (${timezone}).`,
    "When a tool asks for a date/time (block_time, add_task), give it the plain local calendar date (YYYY-MM-DD) and 24-hour clock time (HH:MM) at the clinic — resolve relative phrases ('the next hour', '3pm', 'tomorrow') against today's date and current time above, but never convert to UTC or add/subtract a timezone offset yourself; the tool does that conversion. If a bare time of day has already passed today, assume the user means tomorrow unless they said 'today' explicitly. If you're unsure which day the user means, ask instead of guessing.",
    "Doctors at this clinic:",
    roster,
    defaultDoctor
      ? `The doctor currently in view is ${defaultDoctor.id} (Dr. ${defaultDoctor.fullName}) — use this id for tool calls unless the user names a different doctor from the list above.`
      : "No doctor is currently in view — ask which doctor if a tool needs one and it's ambiguous.",
    "Your tools are elemental building blocks, not one-tool-per-phrasing — compose them to answer whatever's actually asked instead of waiting for an exact match:",
    "- list_appointments: find appointments by doctor/date range/status. Use this first whenever a request refers to a set of existing appointments you don't already have ids for (\"my bookings today\", \"everything with Dr. X this week\", \"all tentative ones\").",
    "- reschedule_appointments / cancel_appointments: act on one or many appointment ids at once (up to 20 per call) — the SAME tool whether the user means one appointment or fifty. For a bulk move, use shiftByDays/shiftByMinutes so each appointment keeps its own original time of day (\"move all of tomorrow's bookings to the day after\" = shiftByDays: 1) — only pass an absolute newStart when acting on exactly one appointment.",
    "- find_next_free_slot / block_time: slot lookup and blocking calendar time, unchanged.",
    "- find_patient_history: look up a patient's visit history by name.",
    "- add_task: a personal to-do/reminder, independent of the calendar — add_task never blocks time on its own. If the task is a real-world activity with a time AND the user also asked to reserve that time, call add_task and block_time both, for the same window. Don't call block_time for ordinary tasks (calls, follow-ups, admin) unless blocking time was actually requested.",
    "For a request touching more than one appointment (\"move my scheduled bookings to next day\", \"cancel everything with Dr. X on Friday\"), call list_appointments first to resolve which ones, then act on all matching ids in a single reschedule_appointments/cancel_appointments call — don't call the single-appointment path in a loop yourself. If the filter is ambiguous (which doctor, which day, which status) ask instead of guessing which appointments were meant. Never claim to have changed something without calling the matching tool.",
    "Keep replies short (1-3 sentences) and concrete: confirm exactly what changed (how many appointments, old→new time) with the real values, not vague confirmations. If a bulk action partially failed, say which ones succeeded and which didn't rather than reporting only overall success.",
    "If a tool call fails, say plainly what went wrong instead of retrying silently more than once.",
  ].join("\n");
}

function createApiV1AssistantRouter({ supabaseClient, nettuClient, twilioClient, model, elevenLabsClient }) {
  const router = Router();

  // POST /api/v1/assistant/speak — synthesizes one reply's text into speech.
  // Short text only (the system prompt already keeps replies to 1-3
  // sentences) — this isn't meant for long-form narration. Returns base64 in
  // the standard envelope rather than raw audio bytes so it works through the
  // same api-client.ts JSON contract as every other endpoint.
  router.post("/speak", async (req, res) => {
    if (!elevenLabsClient) return fail(res, 503, "VOICE_NOT_CONFIGURED", "Voice synthesis is not configured for this deployment");

    const { text } = req.body ?? {};
    if (!text?.trim()) return fail(res, 422, "MISSING_FIELDS", "text is required");

    try {
      const audio = await elevenLabsClient.synthesizeSpeech({ text: text.trim() });
      return ok(res, { audioBase64: audio.toString("base64") });
    } catch (err) {
      req.log?.error({ err }, "[api-v1:assistant] speak failed");
      return fail(res, err.statusCode ?? 502, err.code ?? "VOICE_ERROR", err.message);
    }
  });

  router.post("/", async (req, res) => {
    const { messages, context } = req.body ?? {};
    if (!Array.isArray(messages)) {
      return fail(res, 422, "MISSING_FIELDS", "messages is required");
    }

    try {
      const [doctors, clinic] = await Promise.all([
        tableSvc.listActiveDoctors(supabaseClient, req.staff.clinicId),
        clinicSvc.getClinic(supabaseClient, req.staff.clinicId),
      ]);
      const defaultDoctorId = context?.doctorId ?? req.staff.doctorId ?? doctors[0]?.id ?? null;
      const { timezone } = clinicSvc.getSchedulingRules(clinic ?? {});
      const reminderDoctor = doctors.find((d) => d.id === defaultDoctorId) ?? doctors[0] ?? null;

      const tools = buildAssistantTools({
        supabaseClient,
        nettuClient,
        twilioClient,
        clinicId: req.staff.clinicId,
        staffId: req.staff.staffId,
        timezone,
        reminderDoctor,
        log: req.log,
      });

      const result = streamText({
        model,
        system: systemPromptFor({ role: req.staff.role, doctors, defaultDoctorId, timezone }),
        messages: await convertToModelMessages(messages),
        tools,
        // Lets the model take a tool-call step and then continue with a plain-text
        // reply summarizing the result, instead of stopping right after the tool
        // result (streamText's default with tools configured). 6 (not 5) since
        // the elemental tools encourage a list_appointments -> reschedule/cancel
        // -> reply pattern for anything touching more than one appointment.
        stopWhen: stepCountIs(6),
        // Re-chunks raw token deltas into whole-word chunks with a small,
        // even delay — without this, text can arrive in bursty, uneven
        // fragments that read as janky rather than a smooth typing effect.
        experimental_transform: smoothStream({ delayInMs: 20, chunking: "word" }),
      });

      result.pipeUIMessageStreamToResponse(res);
    } catch (err) {
      req.log?.error({ err }, "[api-v1:assistant] failed");
      return fail(res, err.statusCode ?? 500, err.code ?? "INTERNAL_ERROR", err.message);
    }
  });

  return router;
}

module.exports = { createApiV1AssistantRouter };
