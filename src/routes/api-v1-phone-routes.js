const { Router } = require("express");
const { ok, fail } = require("../lib/response-envelope");
const { requireRole } = require("../middleware/require-role");
const phoneRouteSvc = require("../services/phone-route-service");

// GET/POST/PATCH/DELETE /api/v1/phone-routes — lets a clinic self-register
// which of its real numbers (front desk, per-doctor direct lines) forward to
// the shared Twilio number, instead of that mapping ever being hardcoded.
// Owner-only to write, matching clinic-settings' write gate; any logged-in
// staff member can read.
function createApiV1PhoneRoutesRouter(supabaseClient) {
  const router = Router();

  router.get("/", async (req, res) => {
    try {
      const routes = await phoneRouteSvc.listPhoneRoutes(supabaseClient, req.staff.clinicId);
      return ok(res, { routes });
    } catch (err) {
      req.log?.error({ err }, "[api-v1:phone-routes] list failed");
      return fail(res, err.statusCode ?? 500, err.code ?? "INTERNAL_ERROR", err.message);
    }
  });

  router.post("/", requireRole("owner"), async (req, res) => {
    try {
      const route = await phoneRouteSvc.createPhoneRoute(supabaseClient, { ...req.body, clinicId: req.staff.clinicId });
      return res.status(201).json({ success: true, data: { route }, message: null });
    } catch (err) {
      req.log?.error({ err }, "[api-v1:phone-routes] create failed");
      return fail(res, err.statusCode ?? 500, err.code ?? "INTERNAL_ERROR", err.message);
    }
  });

  router.patch("/:id", requireRole("owner"), async (req, res) => {
    try {
      const route = await phoneRouteSvc.updatePhoneRoute(
        supabaseClient,
        req.staff.clinicId,
        req.params.id,
        req.body ?? {},
      );
      return ok(res, { route });
    } catch (err) {
      req.log?.error({ err }, "[api-v1:phone-routes] update failed");
      return fail(res, err.statusCode ?? 500, err.code ?? "INTERNAL_ERROR", err.message);
    }
  });

  router.delete("/:id", requireRole("owner"), async (req, res) => {
    try {
      await phoneRouteSvc.deletePhoneRoute(supabaseClient, req.staff.clinicId, req.params.id);
      return res.status(204).send();
    } catch (err) {
      req.log?.error({ err }, "[api-v1:phone-routes] delete failed");
      return fail(res, err.statusCode ?? 500, err.code ?? "INTERNAL_ERROR", err.message);
    }
  });

  return router;
}

module.exports = { createApiV1PhoneRoutesRouter };
