// Persistent store: Twilio To-number → clinicId.
// One phone number maps to exactly one clinic; entries are never evicted.
// Populated on the first inbound call from a given number; subsequent calls hit this cache
// instead of Supabase.

const store = new Map();

function set(phoneNumber, clinicId) {
  store.set(phoneNumber, clinicId);
}

function get(phoneNumber) {
  return store.get(phoneNumber) ?? null;
}

function size() {
  return store.size;
}

module.exports = { set, get, size };
