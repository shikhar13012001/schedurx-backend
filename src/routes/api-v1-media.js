const { Router } = require("express");
const { ok, fail } = require("../lib/response-envelope");
const openaiSvc = require("../services/openai-service");

// POST /api/v1/media/transcribe — ephemeral speech-to-text for the Consults
// voice-reply mic button. Unlike visits' /recap, nothing is persisted here —
// the transcript just fills the existing text-reply box, which goes out
// through the already-real POST /:id/messages send path.
function createApiV1MediaRouter(openaiClient) {
  const router = Router();

  router.post("/transcribe", async (req, res) => {
    if (!openaiClient) return fail(res, 503, "AI_NOT_CONFIGURED", "Voice transcription is not configured for this deployment");

    const { audioBase64, filename } = req.body ?? {};
    if (!audioBase64) return fail(res, 422, "MISSING_FIELDS", "audioBase64 is required");

    try {
      const text = await openaiSvc.transcribeAudio(openaiClient, Buffer.from(audioBase64, "base64"), filename);
      return ok(res, { text });
    } catch (err) {
      req.log?.error({ err }, "[api-v1:media] transcribe failed");
      return fail(res, err.statusCode ?? 502, err.code ?? "AI_ERROR", err.message);
    }
  });

  return router;
}

module.exports = { createApiV1MediaRouter };
