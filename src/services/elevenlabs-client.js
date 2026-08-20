// Thin wrapper around ElevenLabs' REST API — plain fetch, no SDK dependency,
// mirroring twilio-client.js's role as the only file that knows a provider's
// wire format. Two callers: the Ask ScheduRx "speak this reply" endpoint
// (api-v1-assistant.js) and the missed-call greeting cache (webhooks-twilio.js).

const ELEVENLABS_BASE_URL = "https://api.elevenlabs.io/v1";

function createElevenLabsClient({ apiKey, voiceId }) {
  return {
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
