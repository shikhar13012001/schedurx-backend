// Internal API — called once by schedurx-ultravox-demo-api's call-service before it
// creates each Ultravox call, since the demo bridge holds no Supabase credentials of
// its own and identify_patient (a no-parameter tool) needs clinicId/phoneNumber to
// already be known when the call connects.
//
// Mirrors what call-service.js used to do directly against Supabase before the split.

const { Router } = require("express");
const tableSvc = require("../services/table-service");
const phoneClinicStore = require("../stores/phone-clinic-store");

// Looks up the clinic for a given Twilio To-number.
// Checks the in-process cache first; falls back to Supabase and caches the result.
// Returns null (and never throws) so the call can still connect on any DB error.
async function resolveClinicId(supabaseClient, toPhone, log) {
  if (!toPhone) return null;

  const cached = phoneClinicStore.get(toPhone);
  if (cached) return cached;

  try {
    const { data } = await supabaseClient.from("Clinic").select("id").eq("phone", toPhone).maybeSingle();

    const clinicId = data?.id ?? null;
    if (clinicId) phoneClinicStore.set(toPhone, clinicId);
    return clinicId;
  } catch (error) {
    log?.warn({ err: error, toPhone }, "[internal] clinic lookup failed — continuing without clinic context");
    return null;
  }
}

// Finds or creates a Patient row for the caller's phone number within the given clinic.
// Returns { patientId: null, isNewPatient: false } (and never throws) on any DB error.
async function resolveOrCreatePatient(supabaseClient, fromPhone, clinicId, log) {
  if (!fromPhone || !clinicId) return { patientId: null, isNewPatient: false };

  try {
    const existing = await tableSvc.findPatientByPhone(supabaseClient, clinicId, fromPhone);
    if (existing) return { patientId: existing.id, isNewPatient: false };

    const created = await tableSvc.createPatient(supabaseClient, clinicId, fromPhone);
    return { patientId: created?.id ?? null, isNewPatient: true };
  } catch (error) {
    log?.warn(
      { err: error, fromPhone, clinicId },
      "[internal] patient bootstrap failed — continuing without patient context",
    );
    return { patientId: null, isNewPatient: false };
  }
}

function createInternalCallContextRouter(supabaseClient) {
  const router = Router();

  router.post("/resolve", async (req, res) => {
    const { toPhone, fromPhone } = req.body ?? {};
    req.log.info({ toPhone, fromPhone }, "[internal] call-context resolve invoked");

    const clinicId = await resolveClinicId(supabaseClient, toPhone, req.log);
    const { patientId, isNewPatient } = await resolveOrCreatePatient(supabaseClient, fromPhone, clinicId, req.log);

    return res.json({ clinicId, patientId, isNewPatient });
  });

  return router;
}

module.exports = { createInternalCallContextRouter };
