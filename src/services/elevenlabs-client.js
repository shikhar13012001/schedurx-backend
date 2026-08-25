// Wrapper around ElevenLabs' API — plain fetch for text-to-speech (mirroring
// twilio-client.js's role as the only file that knows a provider's wire
// format), plus the real `@elevenlabs/elevenlabs-js` SDK for single-use
// token minting (mintRealtimeScribeToken) — the SDK is the only documented
// way to create one, so it's used there rather than guessing a REST
// contract that isn't published. Callers: the Ask ScheduRx "speak this
// reply" endpoint and the missed-call greeting cache (both TTS), and the
// ambient-transcription token endpoint (api-v1-visits.js) for Scribe.

const { ElevenLabsClient } = require("@elevenlabs/elevenlabs-js");

const ELEVENLABS_BASE_URL = "https://api.elevenlabs.io/v1";

function createElevenLabsClient({ apiKey, voiceId }) {
  const sdkClient = new ElevenLabsClient({ apiKey });
  return {
    // A 15-minute, single-use token the browser uses to open its own Scribe
    // real-time WebSocket directly — the API key itself never reaches the
    // client. See now-serving.tsx's ambient-capture mode.
    async mintRealtimeScribeToken() {
      const result = await sdkClient.tokens.singleUse.create("realtime_scribe");
      return result.token;
    },
    // Returns raw MP3 bytes. Short text only (a few sentences) — this is not
    // meant for long-form synthesis.
    async synthesizeSpeech({ text, voiceId: overrideVoiceId } = {}) {
      const response = await fetch(`${ELEVENLABS_BASE_URL}/text-to-speech/${overrideVoiceId ?? voiceId}`, {
        method: "POST",
        headers: {
          "xi-api-key": apiKey,
          "Content-Type": "application/json",
          Accept: "audio/mpeg",
        },
        body: JSON.stringify({
          text,
          model_id: "eleven_multilingual_v2",
          voice_settings: { stability: 0.5, similarity_boost: 0.75 },
        }),
      });

      if (!response.ok) {
        const detail = await response.text().catch(() => "");
        throw Object.assign(new Error(`ElevenLabs synthesis failed (${response.status}): ${detail.slice(0, 300)}`), {
          code: "ELEVENLABS_ERROR",
          statusCode: 502,
        });
      }

      const arrayBuffer = await response.arrayBuffer();
      return Buffer.from(arrayBuffer);
    },
  };
}

module.exports = { createElevenLabsClient };
