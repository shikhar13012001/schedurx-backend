const { Router } = require("express");
const { ok, fail } = require("../lib/response-envelope");
const clinicSvc = require("../services/clinic-service");

// GET /api/v1/clinic — core clinic profile (name/address/phone/logo/hours),
// distinct from /clinic-settings (the jsonb feature-toggle blob). Read-only:
// no screen edits these fields yet, so no PATCH is exposed.
function createApiV1ClinicRouter(supabaseClient) {
  const router = Router();

  router.get("/", async (req, res) => {
    try {
      const clinic = await clinicSvc.requireActiveClinic(supabaseClient, req.staff.clinicId);
      return ok(res, {
        clinic: {
          id: clinic.id,
          name: clinic.name,
          address: clinic.address,
          city: clinic.city,
          phone: clinic.phone,
          logoUrl: clinic.logoUrl,
          timezone: clinic.timezone,
          workingDays: clinic.workingDays,
          openingHour: clinic.openingHour,
          closingHour: clinic.closingHour,
        },
      });
    } catch (err) {
      req.log?.error({ err }, "[api-v1:clinic] get failed");
      return fail(res, err.statusCode ?? 500, err.code ?? "INTERNAL_ERROR", err.message);
    }
  });

  return router;
}

module.exports = { createApiV1ClinicRouter };
