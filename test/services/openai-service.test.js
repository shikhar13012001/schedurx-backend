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
    await assert.rejects(
      () => openaiSvc.generateVisitNote(openaiClient, "doctor gave a recap about the visit today"),
      /AI_RESPONSE_INVALID|unparseable/
    );
  });

  test("refuses locally, without ever calling the model, when the recap is too thin to summarize", async () => {
    const openaiClient = createOpenaiStub({ content: JSON.stringify({ note: "should never be reached" }) });
    const note = await openaiSvc.generateVisitNote(openaiClient, "ok yeah");
    assert.match(note, /too brief/);
  });
});

describe("suggestDuringConsult", () => {
  test("returns the trimmed diagnosis and nextQuestion from a strict-JSON response", async () => {
    const openaiClient = createOpenaiStub({
      content: JSON.stringify({ diagnosis: "  Possible viral URI.  ", nextQuestion: "  How long has the cough lasted?  " }),
    });
    const result = await openaiSvc.suggestDuringConsult(openaiClient, "Patient: I've had a cough for a while.");
    assert.deepEqual(result, { diagnosis: "Possible viral URI.", nextQuestion: "How long has the cough lasted?" });
  });

  test("diagnosis and nextQuestion are independently nullable — one can be present without the other", async () => {
    const openaiClient = createOpenaiStub({ content: JSON.stringify({ diagnosis: null, nextQuestion: "Any fever?" }) });
    const result = await openaiSvc.suggestDuringConsult(openaiClient, "Patient: I've had a cough for a while.");
    assert.deepEqual(result, { diagnosis: null, nextQuestion: "Any fever?" });
  });

  test("returns both null when the model has nothing to suggest yet", async () => {
    const openaiClient = createOpenaiStub({ content: JSON.stringify({ diagnosis: null, nextQuestion: null }) });
    const result = await openaiSvc.suggestDuringConsult(openaiClient, "Doctor: Hello, how are you today?");
    assert.deepEqual(result, { diagnosis: null, nextQuestion: null });
  });

  test("treats an empty/whitespace-only field as null instead of throwing", async () => {
    const openaiClient = createOpenaiStub({ content: JSON.stringify({ diagnosis: "   ", nextQuestion: "" }) });
    const result = await openaiSvc.suggestDuringConsult(openaiClient, "some transcript");
    assert.deepEqual(result, { diagnosis: null, nextQuestion: null });
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
