const { Router } = require("express");
const { ok, fail } = require("../lib/response-envelope");
const { requireRole } = require("../middleware/require-role");
const clinicSvc = require("../services/clinic-service");

// GET /api/v1/clinic — core clinic profile (name/address/phone/logo/hours).
// PATCH /api/v1/clinic — owner-only; reuses updateClinicProfile's existing
// whitelist (CLINIC_PROFILE_FIELDS), same as onboarding's own clinic-profile
// step, but only googleReviewUrl (Phase 7) has a settings screen driving it
// today — this route isn't a general "edit everything" surface yet, just
// wide enough that adding the next editable field later doesn't need a new
// route, matching the whitelist's own existing shape.
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
          googleReviewUrl: clinic.googleReviewUrl ?? null,
          tokenMoneyEnabled: clinic.tokenMoneyEnabled ?? false,
          tokenAmountPaise: clinic.tokenAmountPaise ?? null,
        },
      });
    } catch (err) {
      req.log?.error({ err }, "[api-v1:clinic] get failed");
      return fail(res, err.statusCode ?? 500, err.code ?? "INTERNAL_ERROR", err.message);
    }
  });

  router.patch("/", requireRole("owner"), async (req, res) => {
    try {
      const clinic = await clinicSvc.updateClinicProfile(supabaseClient, req.staff.clinicId, req.body ?? {});
      return ok(res, {
        clinic: {
          googleReviewUrl: clinic.googleReviewUrl ?? null,
          tokenMoneyEnabled: clinic.tokenMoneyEnabled ?? false,
          tokenAmountPaise: clinic.tokenAmountPaise ?? null,
        },
      });
    } catch (err) {
      req.log?.error({ err }, "[api-v1:clinic] update failed");
      return fail(res, err.statusCode ?? 500, err.code ?? "INTERNAL_ERROR", err.message);
    }
  });

  return router;
}

module.exports = { createApiV1ClinicRouter };
