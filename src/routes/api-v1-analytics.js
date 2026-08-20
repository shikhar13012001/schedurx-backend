const { Router } = require("express");
const { ok, fail } = require("../lib/response-envelope");
const analyticsSvc = require("../services/analytics-service");
const openaiSvc = require("../services/openai-service");

// Not gated on stripeClient — day_stats reads Postgres directly and works
// (with revenue at 0) even before Stripe is configured. `openaiClient` is
// optional — only /practice-pulse needs it, same sub-gated pattern as
// api-v1-billing.js's stripeClient.
function createApiV1AnalyticsRouter(supabaseClient, openaiClient) {
  const router = Router();

  router.get("/summary", async (req, res) => {
    const days = Number(req.query.days) || 30;
    try {
      const summary = await analyticsSvc.getSummary(supabaseClient, req.staff.clinicId, { days });
      return ok(res, summary);
    } catch (err) {
      req.log?.error({ err }, "[api-v1:analytics] summary failed");
      return fail(res, err.statusCode ?? 500, err.code ?? "INTERNAL_ERROR", err.message);
    }
  });

  router.get("/utilization", async (req, res) => {
    const days = Number(req.query.days) || 7;
    try {
      const utilization = await analyticsSvc.getUtilization(supabaseClient, req.staff.clinicId, { days });
      return ok(res, utilization);
    } catch (err) {
      req.log?.error({ err }, "[api-v1:analytics] utilization failed");
      return fail(res, err.statusCode ?? 500, err.code ?? "INTERNAL_ERROR", err.message);
    }
  });

  router.get("/practice-pulse", async (req, res) => {
    if (!openaiClient) return fail(res, 503, "AI_NOT_CONFIGURED", "AI insights are not configured for this deployment");
    try {
      const { totals, daily } = await analyticsSvc.getSummary(supabaseClient, req.staff.clinicId, { days: 14 });
      const insights = await openaiSvc.generatePracticePulse(openaiClient, { totals, daily });
      return ok(res, { insights });
    } catch (err) {
      req.log?.error({ err }, "[api-v1:analytics] practice-pulse failed");
      return fail(res, err.statusCode ?? 502, err.code ?? "AI_ERROR", err.message);
    }
  });

  router.post("/refresh", async (req, res) => {
    try {
      await analyticsSvc.refresh(supabaseClient);
      return ok(res, {});
    } catch (err) {
      req.log?.error({ err }, "[api-v1:analytics] refresh failed");
      return fail(res, err.statusCode ?? 500, err.code ?? "INTERNAL_ERROR", err.message);
    }
  });

  return router;
}

module.exports = { createApiV1AnalyticsRouter };
