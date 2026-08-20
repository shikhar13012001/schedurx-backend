const { Router } = require("express");
const { ok, fail } = require("../lib/response-envelope");
const doctorSvc = require("../services/doctor-service");

// PATCH /api/v1/doctors/:id — lets a doctor edit their own fee/slot length/
// working hours/bio from Profile (previously display-only inputs with no
// backend to save to). Restricted to the doctor themselves or the clinic
// owner — not open to any authenticated staff member.
function createApiV1DoctorsRouter(supabaseClient) {
  const router = Router();

  router.patch("/:id", async (req, res) => {
    const isSelf = req.staff.doctorId === req.params.id;
    const isOwner = req.staff.role === "owner";
    if (!isSelf && !isOwner) {
      return fail(res, 403, "FORBIDDEN", "You can only edit your own doctor profile");
    }

    try {
      const doctor = await doctorSvc.requireActiveDoctor(supabaseClient, req.params.id, req.staff.clinicId);
      void doctor; // validated: exists, active, belongs to this clinic
      const updated = await doctorSvc.updateDoctor(supabaseClient, req.params.id, req.body ?? {});
      return ok(res, { doctor: updated });
    } catch (err) {
      req.log?.error({ err }, "[api-v1:doctors] update failed");
      return fail(res, err.statusCode ?? 500, err.code ?? "INTERNAL_ERROR", err.message);
    }
  });

  return router;
}

module.exports = { createApiV1DoctorsRouter };
