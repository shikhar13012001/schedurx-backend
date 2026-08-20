const { Router } = require("express");
const { ok, fail } = require("../lib/response-envelope");
const notificationSvc = require("../services/notification-service");

function createApiV1NotificationsRouter(supabaseClient) {
  const router = Router();

  router.get("/", async (req, res) => {
    try {
      const notifications = await notificationSvc.listNotifications(
        supabaseClient,
        req.staff.clinicId,
        req.staff.staffId,
      );
      return ok(res, { notifications });
    } catch (err) {
      req.log?.error({ err }, "[api-v1:notifications] list failed");
      return fail(res, err.statusCode ?? 500, err.code ?? "INTERNAL_ERROR", err.message);
    }
  });

  router.patch("/read-all", async (req, res) => {
    try {
      await notificationSvc.markAllRead(supabaseClient, req.staff.clinicId, req.staff.staffId);
      return ok(res, {});
    } catch (err) {
      req.log?.error({ err }, "[api-v1:notifications] read-all failed");
      return fail(res, err.statusCode ?? 500, err.code ?? "INTERNAL_ERROR", err.message);
    }
  });

  router.patch("/:id/read", async (req, res) => {
    try {
      const notification = await notificationSvc.markRead(
        supabaseClient,
        req.staff.clinicId,
        req.staff.staffId,
        req.params.id,
      );
      return ok(res, { notification });
    } catch (err) {
      req.log?.error({ err }, "[api-v1:notifications] read failed");
      return fail(res, err.statusCode ?? 500, err.code ?? "INTERNAL_ERROR", err.message);
    }
  });

  router.delete("/:id", async (req, res) => {
    try {
      await notificationSvc.deleteNotification(supabaseClient, req.staff.clinicId, req.staff.staffId, req.params.id);
      return res.status(204).send();
    } catch (err) {
      req.log?.error({ err }, "[api-v1:notifications] delete failed");
      return fail(res, err.statusCode ?? 500, err.code ?? "INTERNAL_ERROR", err.message);
    }
  });

  return router;
}

module.exports = { createApiV1NotificationsRouter };
