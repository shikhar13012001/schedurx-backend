const { Router } = require("express");
const { ok, fail } = require("../lib/response-envelope");
const tableSvc = require("../services/table-service");

// GET /api/v1/patients?q=... — plain list when q is absent, ranked trigram
// search when present. GET /api/v1/patients/:id for the profile screen.
function createApiV1PatientsRouter(supabaseClient) {
  const router = Router();

  router.get("/", async (req, res) => {
    const { q } = req.query;
    try {
      const patients = q
        ? await tableSvc.searchPatients(supabaseClient, req.staff.clinicId, q)
        : await tableSvc.listPatientsForClinic(supabaseClient, req.staff.clinicId);
      return ok(res, { patients });
    } catch (err) {
      req.log?.error({ err }, "[api-v1:patients] list failed");
      return fail(res, err.statusCode ?? 500, err.code ?? "INTERNAL_ERROR", err.message);
    }
  });

  router.get("/:id", async (req, res) => {
    try {
      const patient = await tableSvc.getPatientById(supabaseClient, req.staff.clinicId, req.params.id);
      if (!patient) return fail(res, 404, "PATIENT_NOT_FOUND", `Patient '${req.params.id}' not found`);
      return ok(res, { patient });
    } catch (err) {
      req.log?.error({ err }, "[api-v1:patients] get failed");
      return fail(res, err.statusCode ?? 500, err.code ?? "INTERNAL_ERROR", err.message);
    }
  });

  return router;
}

module.exports = { createApiV1PatientsRouter };
