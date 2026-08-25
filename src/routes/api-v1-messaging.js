// Staff-facing view of tonight's delivery-tracking work (MessageLog,
// FailedMessage) — before this, "did that confirmation actually send" was
// only answerable by querying the database directly. GET-only; nothing
// here writes anything.

const { Router } = require("express");
const { ok, fail } = require("../lib/response-envelope");
const messageLogSvc = require("../services/message-log-service");
const failedMessageSvc = require("../services/failed-message-service");

function createApiV1MessagingRouter(supabaseClient) {
  const router = Router();

  // GET /api/v1/messaging/failures?sinceMinutes=1440 — MessageLog rows that
  // Twilio itself reported as undelivered/failed (real delivery outcomes,
  // not just "we tried to send").
  router.get("/failures", async (req, res) => {
    try {
      const sinceMinutes = req.query.sinceMinutes ? Number(req.query.sinceMinutes) : undefined;
      const failures = await messageLogSvc.listRecentFailures(supabaseClient, { clinicId: req.staff.clinicId, sinceMinutes });
      return ok(res, { failures });
    } catch (err) {
      req.log?.error({ err }, "[api-v1:messaging] list failures failed");
      return fail(res, err.statusCode ?? 500, err.code ?? "INTERNAL_ERROR", err.message);
    }
  });

  // GET /api/v1/messaging/retry-queue?status=exhausted — FailedMessage rows
  // (pending/retrying/exhausted by default; pass status to filter, e.g. to
  // see only what's fully given up and needs a human).
  router.get("/retry-queue", async (req, res) => {
    try {
      const queue = await failedMessageSvc.listForClinic(supabaseClient, { clinicId: req.staff.clinicId, status: req.query.status });
      return ok(res, { queue });
    } catch (err) {
      req.log?.error({ err }, "[api-v1:messaging] list retry queue failed");
      return fail(res, err.statusCode ?? 500, err.code ?? "INTERNAL_ERROR", err.message);
    }
  });

  return router;
}

module.exports = { createApiV1MessagingRouter };
