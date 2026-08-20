const { Router } = require("express");
const { ok, fail } = require("../lib/response-envelope");
const callLogSvc = require("../services/call-log-service");

function createApiV1CallLogsRouter(supabaseClient) {
  const router = Router();

  router.get("/", async (req, res) => {
    try {
      const callLogs = await callLogSvc.listCallLogs(supabaseClient, req.staff.clinicId);
      return ok(res, { callLogs });
    } catch (err) {
      req.log?.error({ err }, "[api-v1:call-logs] list failed");
      return fail(res, err.statusCode ?? 500, err.code ?? "INTERNAL_ERROR", err.message);
    }
  });

  return router;
}

module.exports = { createApiV1CallLogsRouter };
