// In-memory store: ultravoxCallId → { clinicId, phoneNumber, patientId, doctorId, appointment }
//
// clinicId/phoneNumber are seeded by the tools middleware from the static parameters
// Ultravox sends with every tool call (see routes/tools.js); doctorId/patientId/appointment
// are written by identify_patient/select_doctor/book_appointment as the call progresses.
//
// This store never learns when a call ends (that webhook lands on the demo bridge, not
// here), so entries are swept on a TTL well beyond any realistic call duration instead of
// being explicitly removed.

const TTL_MS = 4 * 60 * 60 * 1000; // 4 hours
const SWEEP_INTERVAL_MS = 30 * 60 * 1000;

const store = new Map();

function upsert(callId, patch) {
  const existing = store.get(callId)?.data ?? {};
  store.set(callId, { data: { ...existing, ...patch }, updatedAt: Date.now() });
}

function get(callId) {
  return store.get(callId)?.data ?? null;
}

function remove(callId) {
  store.delete(callId);
}

function size() {
  return store.size;
}

function sweep() {
  const cutoff = Date.now() - TTL_MS;
  for (const [callId, entry] of store) {
    if (entry.updatedAt < cutoff) store.delete(callId);
  }
}

const sweepTimer = setInterval(sweep, SWEEP_INTERVAL_MS);
sweepTimer.unref();

module.exports = { upsert, get, remove, size };
