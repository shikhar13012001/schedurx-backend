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

describe("transcribeAudio", () => {
  test("returns the transcript text", async () => {
    const openaiClient = createOpenaiStub({ transcript: "Please reschedule my appointment to Friday." });
    const text = await openaiSvc.transcribeAudio(openaiClient, Buffer.from("fake-audio-bytes"), "clip.webm");
    assert.equal(text, "Please reschedule my appointment to Friday.");
  });
});
