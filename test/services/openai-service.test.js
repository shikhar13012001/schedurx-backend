const { test, describe } = require("node:test");
const assert = require("node:assert/strict");

const openaiSvc = require("../../src/services/openai-service");
const { createOpenaiStub } = require("../helpers/openai-stub");

describe("generateVisitNote", () => {
  test("returns the structured note from a strict-JSON response", async () => {
    const openaiClient = createOpenaiStub({ content: JSON.stringify({ note: "Patient reports mild fever, prescribed paracetamol." }) });
    const note = await openaiSvc.generateVisitNote(openaiClient, "fever since yesterday, gave paracetamol");
    assert.equal(note, "Patient reports mild fever, prescribed paracetamol.");
  });

  test("throws AI_RESPONSE_INVALID on an unparseable response", async () => {
    const openaiClient = createOpenaiStub({ content: "not json" });
    await assert.rejects(() => openaiSvc.generateVisitNote(openaiClient, "some recap"), /AI_RESPONSE_INVALID|unparseable/);
  });
});

describe("suggestDuringConsult", () => {
  test("returns the trimmed suggestion from a strict-JSON response", async () => {
    const openaiClient = createOpenaiStub({ content: JSON.stringify({ suggestion: "  Consider asking about duration of symptoms.  " }) });
    const suggestion = await openaiSvc.suggestDuringConsult(openaiClient, "Patient: I've had a cough for a while.");
    assert.equal(suggestion, "Consider asking about duration of symptoms.");
  });

  test("returns null (not a string) when the model has nothing to suggest yet", async () => {
    const openaiClient = createOpenaiStub({ content: JSON.stringify({ suggestion: null }) });
    const suggestion = await openaiSvc.suggestDuringConsult(openaiClient, "Doctor: Hello, how are you today?");
    assert.equal(suggestion, null);
  });

  test("returns null for an empty/whitespace-only suggestion instead of throwing", async () => {
    const openaiClient = createOpenaiStub({ content: JSON.stringify({ suggestion: "   " }) });
    const suggestion = await openaiSvc.suggestDuringConsult(openaiClient, "some transcript");
    assert.equal(suggestion, null);
  });

  test("throws AI_RESPONSE_INVALID on an unparseable response", async () => {
    const openaiClient = createOpenaiStub({ content: "not json" });
    await assert.rejects(() => openaiSvc.suggestDuringConsult(openaiClient, "some transcript"), /AI_RESPONSE_INVALID|unparseable/);
  });
});

describe("transcribeAudio", () => {
  test("returns the transcript text", async () => {
    const openaiClient = createOpenaiStub({ transcript: "Please reschedule my appointment to Friday." });
    const text = await openaiSvc.transcribeAudio(openaiClient, Buffer.from("fake-audio-bytes"), "clip.webm");
    assert.equal(text, "Please reschedule my appointment to Friday.");
  });
});
