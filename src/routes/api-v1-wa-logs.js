const { Router } = require("express");
const { ok, fail } = require("../lib/response-envelope");
const callLogSvc = require("../services/call-log-service");

function createApiV1WaLogsRouter(supabaseClient) {
  const router = Router();

  router.get("/", async (req, res) => {
    try {
      const waLogs = await callLogSvc.listWaLogs(supabaseClient, req.staff.clinicId);
      return ok(res, { waLogs });
    } catch (err) {
      req.log?.error({ err }, "[api-v1:wa-logs] list failed");
      return fail(res, err.statusCode ?? 500, err.code ?? "INTERNAL_ERROR", err.message);
    }
  });

  return router;
}

module.exports = { createApiV1WaLogsRouter };
