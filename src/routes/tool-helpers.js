function resolveCallCtx(callStore, ultravoxCallId, log) {
  if (!ultravoxCallId) {
    log?.warn("Tool called without ultravoxCallId — cannot resolve call context");
    return null;
  }
  const ctx = callStore?.get(ultravoxCallId) ?? null;
  if (!ctx) log?.warn({ ultravoxCallId }, "ultravoxCallId not found in call store");
  return ctx;
}

function formatPatient(row, isNew) {
  return {
    patientId: row.id,
    fullName: row.fullName || null,
    contactNumber: row.contactNumber,
    age: row.age ?? null,
    gender: row.gender ?? null,
    clinicId: row.clinicId,
    isNew,
  };
}

function formUrl(clinicId, appointmentId) {
  return `/${clinicId}/${appointmentId}`;
}

module.exports = { resolveCallCtx, formatPatient, formUrl };
