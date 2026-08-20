const { test, describe } = require("node:test");
const assert = require("node:assert/strict");
const { MockLanguageModelV3 } = require("ai/test");

const { respondToPatientMessage } = require("../../src/services/whatsapp-agent-service");
const { createTableStub } = require("../helpers/supabase-table-stub");

const CLINIC = { id: "poc-clinic-001", name: "Dr. Sharma's Clinic", settings: {} };
const PATIENT = { id: "pat_1", fullName: "Rahul" };
const THREAD = { id: "thread_1", contactPhone: "+919555607181" };

function makeSupabase(chatMsgs = []) {
  return createTableStub({
    Doctor: [{ id: "doc-1", fullName: "Dr. Priya", clinicId: CLINIC.id, isActive: true }],
    ChatMsg: chatMsgs,
  });
}

function textOnlyModel(text) {
  return new MockLanguageModelV3({
    doGenerate: async () => ({
      finishReason: "stop",
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      content: [{ type: "text", text }],
      warnings: [],
    }),
  });
}

describe("respondToPatientMessage", () => {
  test("returns the model's trimmed reply text", async () => {
    const supabaseClient = makeSupabase([
      { id: "m1", threadId: THREAD.id, direction: "inbound", body: "Hi, what's my appointment?", createdAt: "2026-01-01" },
    ]);
    const reply = await respondToPatientMessage(
      {
        supabaseClient,
        nettuClient: {},
        twilioClient: {},
        assistantModel: textOnlyModel("  Hi Rahul, you're all set for tomorrow at 3pm.  "),
        clinic: CLINIC,
        patient: PATIENT,
        thread: THREAD,
      },
      null,
    );
    assert.equal(reply, "Hi Rahul, you're all set for tomorrow at 3pm.");
  });

  test("returns null (never throws) when the model fails", async () => {
    const supabaseClient = makeSupabase();
    const failingModel = new MockLanguageModelV3({
      doGenerate: async () => {
        throw new Error("upstream OpenAI error");
      },
    });
    const reply = await respondToPatientMessage(
      { supabaseClient, nettuClient: {}, twilioClient: {}, assistantModel: failingModel, clinic: CLINIC, patient: PATIENT, thread: THREAD },
      null,
    );
    assert.equal(reply, null);
  });

  test("returns null instead of empty string when the model produces no text", async () => {
    const supabaseClient = makeSupabase();
    const reply = await respondToPatientMessage(
      { supabaseClient, nettuClient: {}, twilioClient: {}, assistantModel: textOnlyModel("   "), clinic: CLINIC, patient: PATIENT, thread: THREAD },
      null,
    );
    assert.equal(reply, null);
  });
});
