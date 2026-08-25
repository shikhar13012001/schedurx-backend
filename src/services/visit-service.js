// Visit: the clinical record produced when a doctor sees a patient — distinct
// from Appointment.auditHistory, which only logs booking/scheduling events.

const { makeId } = require("../lib/ids");

function dbErr(msg) {
  return Object.assign(new Error(`DB error ${msg}`), { code: "DATABASE_ERROR", statusCode: 500 });
}

async function listVisitsForPatient(supabaseClient, clinicId, patientId) {
  const { data, error } = await supabaseClient
    .from("Visit")
    .select("*")
    .eq("clinicId", clinicId)
    .eq("patientId", patientId)
    .order("visitDate", { ascending: false });
  if (error) throw dbErr(`listing visits: ${error.message}`);
  return data ?? [];
}

async function createVisit(supabaseClient, opts) {
  const {
    clinicId,
    patientId,
    doctorId,
    appointmentId,
    visitDate,
    mode,
    symptoms,
    notes,
    prescription,
    vitals,
    followUpDate,
  } = opts;

  if (!clinicId || !patientId) {
    throw Object.assign(new Error("clinicId and patientId are required"), { code: "MISSING_FIELDS", statusCode: 422 });
  }

  const now = new Date().toISOString();
  const { data, error } = await supabaseClient
    .from("Visit")
    .insert({
      id: makeId("visit"),
      clinicId,
      patientId,
      doctorId: doctorId ?? null,
      appointmentId: appointmentId ?? null,
      visitDate: visitDate ?? now.slice(0, 10),
      mode: mode ?? null,
      symptoms: symptoms ?? null,
      notes: notes ?? null,
      prescription: prescription ?? [],
      vitals: vitals ?? {},
      followUpDate: followUpDate ?? null,
      status: "open",
      createdAt: now,
      updatedAt: now,
    })
    .select()
    .single();

  if (error) throw dbErr(`creating visit: ${error.message}`);
  return data;
}

// Idempotent counterpart to createVisit — used where nothing has already
// confirmed whether today's Visit exists (appointment-service.js's
// markCompleted, fired when a queue check-in finishes, whether or not the
// doctor ever ran ambient capture/Recap during the consult). If ambient
// capture already created today's row, this finds and returns it as-is
// rather than creating a duplicate; if not, it creates a bare one so the
// patient's visit history and count are never silently empty just because
// nobody tapped the mic.
async function findOrCreateTodaysVisit(supabaseClient, opts) {
  const { clinicId, patientId, visitDate } = opts;
  if (!clinicId || !patientId) {
    throw Object.assign(new Error("clinicId and patientId are required"), { code: "MISSING_FIELDS", statusCode: 422 });
  }
  const date = visitDate ?? new Date().toISOString().slice(0, 10);

  // Same "patientId + today's date" scope the client-side check in
  // now-serving.tsx already uses — not appointment-scoped (a patient with
  // two same-day appointments already shares one Visit row today; matching
  // that rather than redesigning visit identity here). Ordered so a patient
  // with more than one row for the date deterministically resolves to the
  // most recent rather than arbitrary DB order.
  const { data: existing, error: findErr } = await supabaseClient
    .from("Visit")
    .select("*")
    .eq("clinicId", clinicId)
    .eq("patientId", patientId)
    .eq("visitDate", date)
    .order("createdAt", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (findErr) throw dbErr(`finding today's visit: ${findErr.message}`);
  if (existing) return existing;

  return createVisit(supabaseClient, { ...opts, visitDate: date });
}

async function updateVisit(supabaseClient, clinicId, visitId, patch) {
  const { data, error } = await supabaseClient
    .from("Visit")
    .update({ ...patch, updatedAt: new Date().toISOString() })
    .eq("id", visitId)
    .eq("clinicId", clinicId)
    .select()
    .maybeSingle();

  if (error) throw dbErr(`updating visit: ${error.message}`);
  if (!data)
    throw Object.assign(new Error(`Visit '${visitId}' not found`), { code: "VISIT_NOT_FOUND", statusCode: 404 });
  return data;
}

const RX_BUCKET = "rx-attachments";

// Browser uploads bytes directly to Supabase Storage using this signed URL —
// never through our Express server. Path is namespaced by clinic+visit so a
// leaked signed URL can't be replayed against another clinic's storage.
async function createUploadUrl(supabaseClient, clinicId, visitId, { fileName, contentType }) {
  const safeName = String(fileName ?? "upload").replace(/[^a-zA-Z0-9_.-]/g, "_");
  const path = `${clinicId}/${visitId}/${Date.now()}-${safeName}`;

  const { data, error } = await supabaseClient.storage.from(RX_BUCKET).createSignedUploadUrl(path);
  if (error) throw dbErr(`creating signed upload URL: ${error.message}`);

  return { path, uploadUrl: data.signedUrl, token: data.token, contentType: contentType ?? null };
}

// Called after a successful direct-to-storage upload — appends the attachment
// to Visit.rxAttachments (a private bucket path, never a public URL).
async function addAttachment(supabaseClient, clinicId, visitId, { path, type }) {
  if (!path || !["photo", "digital"].includes(type)) {
    throw Object.assign(new Error("path and a valid type ('photo'|'digital') are required"), {
      code: "MISSING_FIELDS",
      statusCode: 422,
    });
  }

  const { data: visit, error: fetchErr } = await supabaseClient
    .from("Visit")
    .select("rxAttachments")
    .eq("id", visitId)
    .eq("clinicId", clinicId)
    .maybeSingle();
  if (fetchErr) throw dbErr(`fetching visit: ${fetchErr.message}`);
  if (!visit)
    throw Object.assign(new Error(`Visit '${visitId}' not found`), { code: "VISIT_NOT_FOUND", statusCode: 404 });

  const attachment = { path, type, uploadedAt: new Date().toISOString() };
  const rxAttachments = [...(visit.rxAttachments ?? []), attachment];

  const { data, error } = await supabaseClient
    .from("Visit")
    .update({ rxAttachments, updatedAt: new Date().toISOString() })
    .eq("id", visitId)
    .eq("clinicId", clinicId)
    .select()
    .maybeSingle();
  if (error) throw dbErr(`updating visit attachments: ${error.message}`);
  return data;
}

// Short-lived read URL for a private-bucket attachment path.
async function createReadUrl(supabaseClient, path) {
  const { data, error } = await supabaseClient.storage.from(RX_BUCKET).createSignedUrl(path, 60 * 10);
  if (error) throw dbErr(`creating signed read URL: ${error.message}`);
  return data.signedUrl;
}

module.exports = {
  listVisitsForPatient,
  createVisit,
  findOrCreateTodaysVisit,
  updateVisit,
  createUploadUrl,
  addAttachment,
  createReadUrl,
};
