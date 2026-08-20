const { test, describe, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");

const { createElevenLabsClient } = require("../../src/services/elevenlabs-client");

describe("synthesizeSpeech", () => {
  let originalFetch;
  beforeEach(() => { originalFetch = global.fetch; });
  afterEach(() => { global.fetch = originalFetch; });

  test("posts to the right voice endpoint with the api key header and returns a Buffer", async () => {
    let capturedUrl, capturedInit;
    global.fetch = async (url, init) => {
      capturedUrl = url;
      capturedInit = init;
      return {
        ok: true,
        arrayBuffer: async () => new TextEncoder().encode("fake-mp3-bytes").buffer,
      };
    };

    const client = createElevenLabsClient({ apiKey: "test-key", voiceId: "voice-abc" });
    const result = await client.synthesizeSpeech({ text: "Hi there" });

    assert.equal(capturedUrl, "https://api.elevenlabs.io/v1/text-to-speech/voice-abc");
    assert.equal(capturedInit.headers["xi-api-key"], "test-key");
    assert.equal(JSON.parse(capturedInit.body).text, "Hi there");
    assert.ok(Buffer.isBuffer(result));
    assert.equal(result.toString(), "fake-mp3-bytes");
  });

  test("an explicit voiceId overrides the client's default", async () => {
    let capturedUrl;
    global.fetch = async (url) => {
      capturedUrl = url;
      return { ok: true, arrayBuffer: async () => new ArrayBuffer(0) };
    };
    const client = createElevenLabsClient({ apiKey: "test-key", voiceId: "default-voice" });
    await client.synthesizeSpeech({ text: "Hi", voiceId: "custom-voice" });
    assert.equal(capturedUrl, "https://api.elevenlabs.io/v1/text-to-speech/custom-voice");
  });

  test("throws a structured error on a non-ok response", async () => {
    global.fetch = async () => ({ ok: false, status: 401, text: async () => "invalid api key" });
    const client = createElevenLabsClient({ apiKey: "bad-key", voiceId: "voice-abc" });
    await assert.rejects(() => client.synthesizeSpeech({ text: "Hi" }), (err) => {
      assert.equal(err.code, "ELEVENLABS_ERROR");
      assert.match(err.message, /401/);
      return true;
    });
  });
});
