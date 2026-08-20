const { Router } = require("express");
const { ok, fail } = require("../lib/response-envelope");
const pushSvc = require("../services/push-service");

function createApiV1PushSubscriptionsRouter(supabaseClient) {
  const router = Router();

  router.post("/", async (req, res) => {
    const { subscription } = req.body ?? {};
    if (!subscription?.endpoint || !subscription?.keys) {
      return fail(res, 422, "MISSING_FIELDS", "subscription.endpoint and subscription.keys are required");
    }

    try {
      const saved = await pushSvc.saveSubscription(supabaseClient, { staffId: req.staff.staffId, subscription });
      return res.status(201).json({ success: true, data: { subscription: saved }, message: null });
    } catch (err) {
      req.log?.error({ err }, "[api-v1:push-subscriptions] save failed");
      return fail(res, err.statusCode ?? 500, err.code ?? "INTERNAL_ERROR", err.message);
    }
  });

  return router;
}

module.exports = { createApiV1PushSubscriptionsRouter };
