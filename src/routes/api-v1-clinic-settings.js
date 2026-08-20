const { Router } = require("express");
const { ok, fail } = require("../lib/response-envelope");
const { requireRole } = require("../middleware/require-role");
const clinicSvc = require("../services/clinic-service");

// GET/PATCH /api/v1/clinic-settings — the Profile page's toggles (billing,
// digitalRx, receptionAnalytics, aiAssistant, autoFollowUp, captureMode,
// viewMode). Writing settings is owner-only; reading is any logged-in role.
function createApiV1ClinicSettingsRouter(supabaseClient) {
  const router = Router();

  router.get("/", async (req, res) => {
    try {
      const settings = await clinicSvc.getClinicSettings(supabaseClient, req.staff.clinicId);
      return ok(res, { settings });
    } catch (err) {
      req.log?.error({ err }, "[api-v1:clinic-settings] get failed");
      return fail(res, err.statusCode ?? 500, err.code ?? "INTERNAL_ERROR", err.message);
    }
  });

  router.patch("/", requireRole("owner"), async (req, res) => {
    try {
      const settings = await clinicSvc.updateClinicSettings(supabaseClient, req.staff.clinicId, req.body ?? {});
      return ok(res, { settings });
    } catch (err) {
      req.log?.error({ err }, "[api-v1:clinic-settings] update failed");
      return fail(res, err.statusCode ?? 500, err.code ?? "INTERNAL_ERROR", err.message);
    }
  });

  return router;
}

module.exports = { createApiV1ClinicSettingsRouter };
