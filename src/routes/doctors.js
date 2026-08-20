const { Router } = require("express");
const { resolveCallCtx } = require("./tool-helpers");
const tableSvc = require("../services/table-service");
const doctorSvc = require("../services/doctor-service");

function createDoctorsRouter(supabaseClient, callStore) {
  const router = Router();

  // List all active doctors for this clinic.
  router.post("/list", async (req, res) => {
    req.log.info({ body: req.body }, "[tool] list_doctors invoked");
    const { ultravoxCallId } = req.body ?? {};

    const ctx = resolveCallCtx(callStore, ultravoxCallId, req.log);
    if (!ctx?.clinicId) {
      return res.status(422).json({ error: "clinicId could not be resolved from call context" });
    }

    let doctors;
    try {
      doctors = await tableSvc.listActiveDoctors(supabaseClient, ctx.clinicId);
    } catch (err) {
      req.log.error({ err, clinicId: ctx.clinicId }, "Doctor list failed");
      return res.status(500).json({ error: "Internal server error" });
    }

    return res.json({
      doctors: doctors.map((d) => ({
        doctorId: d.id,
        fullName: d.fullName,
        specialty: d.specialty ?? null,
        qualification: d.qualification ?? null,
        languages: d.languages ?? null,
        feeInr: d.feeInr,
      })),
    });
  });

  // Resolve a doctor by spoken name and persist their scheduler IDs into call context.
  // After this call, calendar tools resolve doctorId from context — the agent never passes it.
  router.post("/select", async (req, res) => {
    req.log.info({ body: req.body }, "[tool] select_doctor invoked");
    const { ultravoxCallId, doctorName } = req.body ?? {};

    if (!doctorName?.trim()) {
      return res.status(422).json({ error: "doctorName is required" });
    }

    const ctx = resolveCallCtx(callStore, ultravoxCallId, req.log);
    if (!ctx?.clinicId) {
      return res.status(422).json({ error: "clinicId could not be resolved — call identify_patient first" });
    }

    let doctors;
    try {
      doctors = await tableSvc.listActiveDoctors(supabaseClient, ctx.clinicId);
    } catch (err) {
      req.log.error({ err, clinicId: ctx.clinicId }, "Doctor list failed during select");
      return res.status(500).json({ error: "Internal server error" });
    }

    const matched = doctorSvc.matchDoctorByName(doctors, doctorName);

    if (!matched) {
      return res.status(404).json({
        error: `No doctor matched '${doctorName}'`,
        availableDoctors: doctors.map((d) => d.fullName),
      });
    }

    // Store the resolved IDs — all subsequent calendar tool calls will read from here.
    if (ultravoxCallId) {
      callStore?.upsert(ultravoxCallId, {
        doctorId: matched.id,
        schedulerDoctorId: matched.schedulerDoctorId ?? null,
        schedulerCalendarId: matched.schedulerCalendarId ?? null,
      });
    }

    req.log.info({ doctorId: matched.id, fullName: matched.fullName }, "[tool] doctor selected");

    return res.json({
      doctorId: matched.id,
      fullName: matched.fullName,
      specialty: matched.specialty ?? null,
      qualification: matched.qualification ?? null,
      languages: matched.languages ?? null,
      feeInr: matched.feeInr,
    });
  });

  return router;
}

module.exports = { createDoctorsRouter };
