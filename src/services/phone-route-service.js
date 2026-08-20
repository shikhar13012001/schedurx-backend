// Resolves an inbound Twilio call's ORIGINAL destination (the real clinic/
// doctor number that forwarded, not the Twilio number it landed on) to a
// clinic/doctor, and owns the PhoneNumberRoute table this depends on.
//
// Twilio's number-to-Clinic resolution used to assume one Twilio number maps
// to exactly one clinic (see phone-clinic-store.js / internal-call-context.js
// — an in-memory cache keyed by Twilio's own `To` number). That doesn't hold
// once one shared Twilio account/number pool serves many clinics' forwarded
// calls — the thing that's actually clinic-specific is the ORIGINAL number
// the patient dialed, before it got forwarded, which is what this resolves.

const { makeId } = require("../lib/ids");

function dbErr(msg) {
  return Object.assign(new Error(`DB error ${msg}`), { code: "DATABASE_ERROR", statusCode: 500 });
}
function notFound(id) {
  return Object.assign(new Error(`Phone route '${id}' not found`), { code: "PHONE_ROUTE_NOT_FOUND", statusCode: 404 });
}

function normalizePhone(raw) {
  if (!raw || typeof raw !== "string") return null;
  const digits = raw.replace(/\D/g, "");
  if (!digits) return null;
  return `+${digits}`;
}

// SIP Diversion/History-Info headers look like `<sip:+919999999999@host>;reason=...`
// or `"Name" <tel:+919999999999>` — pull just the number out.
function extractNumberFromSipHeader(value) {
  if (!value || typeof value !== "string") return null;
  const match = value.match(/(?:sip:|tel:)?(\+?\d{7,15})/);
  return match ? match[1] : null;
}

// Twilio call-forwarding metadata, in priority order of reliability:
// - ForwardedFrom: populated when the carrier's SIP/PSTN forward includes a
//   Diversion/History-Info header Twilio itself recognizes and folds in.
// - SIP Diversion/History-Info headers directly, for setups where Twilio
//   doesn't already surface them as ForwardedFrom.
// - To: the number Twilio itself received the call on — always present, but
//   for a shared forwarding number this is the TWILIO number, not the
//   clinic's real one, so it's the last, least specific resort.
function resolveOriginalDestination(req) {
  const body = req.body ?? {};
  const headers = req.headers ?? {};
  const candidates = [
    body.ForwardedFrom,
    headers["diversion"],
    headers["x-diversion"],
    headers["history-info"],
    body.To,
  ];

  for (const candidate of candidates) {
    const normalized = normalizePhone(extractNumberFromSipHeader(candidate));
    if (normalized) return normalized;
  }
  return null;
}

// Resolves a normalized original number to { clinicId, doctorId }, or null if
// unresolvable — callers must handle null with a safe fallback, never assume
// a resolution. Falls back to the pre-existing Clinic.phone exact-match for
// clinics that haven't registered a PhoneNumberRoute yet, so nothing breaks
// for clinics onboarded before this table existed.
async function resolveRoute(supabaseClient, originalNumber) {
  if (!originalNumber) return null;

  const { data: route, error } = await supabaseClient
    .from("PhoneNumberRoute")
    .select("clinicId, doctorId")
    .eq("originalNumber", originalNumber)
    .eq("isActive", true)
    .maybeSingle();
  if (error) throw dbErr(`resolving phone route: ${error.message}`);
  if (route) return { clinicId: route.clinicId, doctorId: route.doctorId ?? null };

  const { data: clinic, error: clinicErr } = await supabaseClient
    .from("Clinic")
    .select("id")
    .eq("phone", originalNumber)
    .maybeSingle();
  if (clinicErr) throw dbErr(`resolving clinic by phone: ${clinicErr.message}`);
  return clinic ? { clinicId: clinic.id, doctorId: null } : null;
}

async function listPhoneRoutes(supabaseClient, clinicId) {
  const { data, error } = await supabaseClient
    .from("PhoneNumberRoute")
    .select("*")
    .eq("clinicId", clinicId)
    .order("createdAt", { ascending: true });
  if (error) throw dbErr(`listing phone routes: ${error.message}`);
  return data ?? [];
}

async function createPhoneRoute(supabaseClient, { clinicId, doctorId, originalNumber, twilioNumber }) {
  const normalized = normalizePhone(originalNumber);
  if (!normalized) {
    throw Object.assign(new Error("originalNumber is required"), { code: "MISSING_FIELDS", statusCode: 422 });
  }

  const now = new Date().toISOString();
  const { data, error } = await supabaseClient
    .from("PhoneNumberRoute")
    .insert({
      id: makeId("route"),
      clinicId,
      doctorId: doctorId ?? null,
      originalNumber: normalized,
      twilioNumber: twilioNumber ? normalizePhone(twilioNumber) : null,
      isActive: true,
      createdAt: now,
      updatedAt: now,
    })
    .select()
    .single();
  if (error) throw dbErr(`creating phone route: ${error.message}`);
  return data;
}

async function updatePhoneRoute(supabaseClient, clinicId, routeId, patch) {
  const updates = { updatedAt: new Date().toISOString() };
  if (patch.doctorId !== undefined) updates.doctorId = patch.doctorId;
  if (patch.originalNumber !== undefined) updates.originalNumber = normalizePhone(patch.originalNumber);
  if (patch.twilioNumber !== undefined)
    updates.twilioNumber = patch.twilioNumber ? normalizePhone(patch.twilioNumber) : null;
  if (patch.isActive !== undefined) updates.isActive = patch.isActive;

  const { data, error } = await supabaseClient
    .from("PhoneNumberRoute")
    .update(updates)
    .eq("id", routeId)
    .eq("clinicId", clinicId)
    .select()
    .maybeSingle();
  if (error) throw dbErr(`updating phone route: ${error.message}`);
  if (!data) throw notFound(routeId);
  return data;
}

async function deletePhoneRoute(supabaseClient, clinicId, routeId) {
  const { error } = await supabaseClient.from("PhoneNumberRoute").delete().eq("id", routeId).eq("clinicId", clinicId);
  if (error) throw dbErr(`deleting phone route: ${error.message}`);
}

module.exports = {
  normalizePhone,
  resolveOriginalDestination,
  resolveRoute,
  listPhoneRoutes,
  createPhoneRoute,
  updatePhoneRoute,
  deletePhoneRoute,
};
