// Thin wrapper around the official `openai` SDK. Starts with triage
// classification (used by the messaging inbox's critical/moderate/routine
// sort) since that's the first concrete consumer; other prompts (visit-note
// drafting, the assistant's tool-calling) reuse chatCompletion() directly.

const { toFile } = require("openai");
const { config } = require("../config");

async function chatCompletion(openaiClient, { messages, responseFormat }) {
  const completion = await openaiClient.chat.completions.create({
    model: config.OPENAI_MODEL,
    messages,
    ...(responseFormat ? { response_format: responseFormat } : {}),
  });
  return completion.choices[0]?.message?.content ?? "";
}

async function classifyTriage(openaiClient, text) {
  const raw = await chatCompletion(openaiClient, {
    messages: [
      {
        role: "system",
        content:
          "You triage inbound patient messages for a clinic. Reply with strict JSON: " +
          '{"triage": "critical"|"moderate"|"routine", "summary": "<one sentence>"}.',
      },
      { role: "user", content: text },
    ],
    responseFormat: { type: "json_object" },
  });

  try {
    const parsed = JSON.parse(raw);
    if (!["critical", "moderate", "routine"].includes(parsed.triage)) throw new Error("invalid triage value");
    return parsed;
  } catch (err) {
    throw Object.assign(new Error(`OpenAI returned an unparseable triage response: ${err.message}`), {
      code: "AI_RESPONSE_INVALID",
      statusCode: 502,
    });
  }
}

// Feeds a day_stats summary (see analytics-service.getSummary) in, gets 3
// insight bullets out — same json_object pattern as classifyTriage.
async function generatePracticePulse(openaiClient, statsSummary) {
  const raw = await chatCompletion(openaiClient, {
    messages: [
      {
        role: "system",
        content:
          "You are a practice-performance assistant for an Indian clinic. Given a JSON summary of " +
          "recent daily stats (appointments, cancellations, revenue, unique patients), reply with strict " +
          'JSON: {"insights": ["<insight 1>", "<insight 2>", "<insight 3>"]}. Each insight is one short, ' +
          "concrete, actionable sentence grounded only in the numbers given — no generic advice.",
      },
      { role: "user", content: JSON.stringify(statsSummary) },
    ],
    responseFormat: { type: "json_object" },
  });

  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed.insights)) throw new Error("missing insights array");
    return parsed.insights.filter((i) => typeof i === "string");
  } catch (err) {
    throw Object.assign(new Error(`OpenAI returned an unparseable practice-pulse response: ${err.message}`), {
      code: "AI_RESPONSE_INVALID",
      statusCode: 502,
    });
  }
}

// Turns a short recorded/typed recap into a structured clinical note — the
// same primitive backs both the manual "Recap" flow and ambient capture
// (visits-recap.js's route decides which one triggered it, this doesn't care).
async function generateVisitNote(openaiClient, rawText) {
  const raw = await chatCompletion(openaiClient, {
    messages: [
      {
        role: "system",
        content:
          "You turn a doctor's short spoken or typed recap of a patient consult into a clean clinical note. " +
          "Reply with strict JSON: {\"note\": \"<2-4 sentence clinical note, third person, factual, no invented " +
          'details beyond what was said>"}.',
      },
      { role: "user", content: rawText },
    ],
    responseFormat: { type: "json_object" },
  });

  try {
    const parsed = JSON.parse(raw);
    if (typeof parsed.note !== "string" || !parsed.note.trim()) throw new Error("missing note");
    return parsed.note.trim();
  } catch (err) {
    throw Object.assign(new Error(`OpenAI returned an unparseable visit-note response: ${err.message}`), {
      code: "AI_RESPONSE_INVALID",
      statusCode: 502,
    });
  }
}

// audioBuffer: raw bytes (already base64-decoded by the caller). filename's
// extension tells Whisper the container format — pass through whatever the
// browser recorded (webm/ogg/mp4 are all supported).
async function transcribeAudio(openaiClient, audioBuffer, filename = "audio.webm") {
  const file = await toFile(audioBuffer, filename);
  const result = await openaiClient.audio.transcriptions.create({ file, model: "whisper-1" });
  return result.text ?? "";
}

module.exports = { chatCompletion, classifyTriage, generatePracticePulse, generateVisitNote, transcribeAudio };
