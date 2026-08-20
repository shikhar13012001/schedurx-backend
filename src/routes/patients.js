const { Router } = require("express");
const { resolveCallCtx, formatPatient } = require("./tool-helpers");
const tableSvc = require("../services/table-service");

function createPatientsRouter(supabaseClient, callStore) {
  const router = Router();

  router.post("/identify", async (req, res) => {
    req.log.info({ body: req.body }, "[tool] identify_patient invoked");
    const { ultravoxCallId } = req.body ?? {};

    const ctx = resolveCallCtx(callStore, ultravoxCallId, req.log);
    if (!ctx?.clinicId || !ctx?.phoneNumber) {
      return res.status(422).json({ error: "Unable to resolve clinic or caller from call context" });
    }
    const { clinicId, phoneNumber } = ctx;

    let patient;
    try {
      patient = await tableSvc.findPatientByPhone(supabaseClient, clinicId, phoneNumber);
    } catch (err) {
      req.log.error({ err, phoneNumber, clinicId }, "Patient lookup failed");
      return res.status(500).json({ error: "Internal server error" });
    }

    if (patient) {
      if (ultravoxCallId) callStore?.upsert(ultravoxCallId, { patientId: patient.id });
      return res.json(formatPatient(patient, false));
    }

    let created;
    try {
      created = await tableSvc.createPatient(supabaseClient, clinicId, phoneNumber);
    } catch (err) {
      req.log.error({ err, phoneNumber, clinicId }, "Patient creation failed");
      return res.status(500).json({ error: "Internal server error" });
    }

    if (ultravoxCallId) callStore?.upsert(ultravoxCallId, { patientId: created.id });
    return res.status(201).json(formatPatient(created, true));
  });

  router.post("/update", async (req, res) => {
    req.log.info({ body: req.body }, "[tool] update_patient invoked");
    const { ultravoxCallId, fullName, age, gender } = req.body ?? {};

    const ctx = resolveCallCtx(callStore, ultravoxCallId, req.log);
    if (!ctx?.patientId) {
      return res.status(422).json({ error: "Unable to resolve patientId — call identify_patient first" });
    }

    const patch = {};
    if (fullName !== undefined) patch.fullName = fullName ?? null;
    if (age !== undefined) patch.age = age ?? null;
    if (gender !== undefined) patch.gender = gender ?? null;

    let data;
    try {
      data = await tableSvc.updatePatientFields(supabaseClient, ctx.patientId, patch);
    } catch (err) {
      req.log.error({ err, patientId: ctx.patientId }, "Patient update failed");
      return res.status(500).json({ error: "Internal server error" });
    }

    if (!data) return res.status(404).json({ error: "Patient not found" });
    return res.json(formatPatient(data, false));
  });

  return router;
}

module.exports = { createPatientsRouter };
