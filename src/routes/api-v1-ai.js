const { Router } = require("express");
const { ok, fail } = require("../lib/response-envelope");
const openaiSvc = require("../services/openai-service");

// Only mounted when openaiClient is configured (see api-v1.js) — matches the
// whole-subsystem conditional-mount pattern used for nettuClient/firebaseAdminApp.
function createApiV1AiRouter(openaiClient) {
  const router = Router();

  router.post("/triage", async (req, res) => {
    const { text } = req.body ?? {};
    if (!text) return fail(res, 422, "MISSING_FIELDS", "text is required");

    try {
      const result = await openaiSvc.classifyTriage(openaiClient, text);
      return ok(res, result);
    } catch (err) {
      req.log?.error({ err }, "[api-v1:ai] triage failed");
      return fail(res, err.statusCode ?? 502, err.code ?? "AI_ERROR", err.message);
    }
  });

  return router;
}

module.exports = { createApiV1AiRouter };
