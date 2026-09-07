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

  // GET /api/v1/analytics/enterprise?days=30 — financial, operational, and
  // patient-level breakdowns beyond day_stats' single revenue/appointments/
  // cancellations rollup (see analytics-service.js's own section comment
  // for why each of these reads live tables directly instead of that view).
  // One combined route rather than one-per-metric, matching this router's
  // existing "one GET per screen's worth of data" shape.
  router.get("/enterprise", async (req, res) => {
    const days = Number(req.query.days) || 30;
    const clinicId = req.staff.clinicId;
    try {
      const [revenueByDoctor, revenueByMode, outstanding, noShow, queueTimings, returnRateByDoctor, repeatVisitTrend] = await Promise.all([
        analyticsSvc.getRevenueByDoctor(supabaseClient, clinicId, { days }),
        analyticsSvc.getRevenueByMode(supabaseClient, clinicId, { days }),
        analyticsSvc.getOutstandingInvoices(supabaseClient, clinicId),
        analyticsSvc.getNoShowRate(supabaseClient, clinicId, { days }),
        analyticsSvc.getQueueTimings(supabaseClient, clinicId, { days }),
        analyticsSvc.getReturnRateByDoctor(supabaseClient, clinicId),
        analyticsSvc.getRepeatVisitTrend(supabaseClient, clinicId, { months: 6 }),
      ]);
      return ok(res, { revenueByDoctor, revenueByMode, outstanding, noShow, queueTimings, returnRateByDoctor, repeatVisitTrend });
    } catch (err) {
      req.log?.error({ err }, "[api-v1:analytics] enterprise failed");
      return fail(res, err.statusCode ?? 500, err.code ?? "INTERNAL_ERROR", err.message);
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
