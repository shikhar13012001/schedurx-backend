const { Router } = require("express");
const { ok, fail } = require("../lib/response-envelope");
const { requireRole } = require("../middleware/require-role");
const whitelistSvc = require("../services/caller-whitelist-service");

// GET/POST/DELETE /api/v1/caller-whitelist — clinic-scoped "log a missed
// call from this number anyway, even though it's a saved contact" list for
// the Android missed-call safety net. Read is any logged-in staff member;
// write is owner or receptionist — receptionists are typically the ones
// actually fielding these calls day to day, unlike most other Automations
// settings (workflows, phone routing), which stay owner-only.
function createApiV1CallerWhitelistRouter(supabaseClient) {
  const router = Router();

  router.get("/", async (req, res) => {
    try {
      const whitelist = await whitelistSvc.listWhitelist(supabaseClient, req.staff.clinicId);
      return ok(res, { whitelist });
    } catch (err) {
      req.log?.error({ err }, "[api-v1:caller-whitelist] list failed");
      return fail(res, err.statusCode ?? 500, err.code ?? "INTERNAL_ERROR", err.message);
    }
  });

  router.post("/", requireRole("owner", "receptionist"), async (req, res) => {
    try {
      const entry = await whitelistSvc.addToWhitelist(supabaseClient, req.staff.clinicId, {
        ...req.body,
        addedByStaffId: req.staff.staffId,
      });
      return res.status(201).json({ success: true, data: { entry }, message: null });
    } catch (err) {
      req.log?.error({ err }, "[api-v1:caller-whitelist] create failed");
      return fail(res, err.statusCode ?? 500, err.code ?? "INTERNAL_ERROR", err.message);
    }
  });

  router.delete("/:id", requireRole("owner", "receptionist"), async (req, res) => {
    try {
      await whitelistSvc.removeFromWhitelist(supabaseClient, req.staff.clinicId, req.params.id);
      return res.status(204).send();
    } catch (err) {
      req.log?.error({ err }, "[api-v1:caller-whitelist] delete failed");
      return fail(res, err.statusCode ?? 500, err.code ?? "INTERNAL_ERROR", err.message);
    }
  });

  return router;
}

module.exports = { createApiV1CallerWhitelistRouter };
