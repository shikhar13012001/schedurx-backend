// Visit: the clinical record produced when a doctor sees a patient — distinct
// from Appointment.auditHistory, which only logs booking/scheduling events.

const { makeId } = require("../lib/ids");
const messagingSvc = require("./messaging-service");
const tableSvc = require("./table-service");
const clinicSvc = require("./clinic-service");
const { createRxToken } = require("../lib/rx-token");
const { config } = require("../config");

function dbErr(msg) {
  return Object.assign(new Error(`DB error ${msg}`), { code: "DATABASE_ERROR", statusCode: 500 });
}

async function listVisitsForPatient(supabaseClient, clinicId, patientId) {
  // visitDate is day-granularity only, so a patient with more than one Visit
  // on the same day (common during testing, but also a real possibility —
  // e.g. two same-day walk-ins) would otherwise come back in arbitrary DB
  // order. createdAt as a tiebreaker keeps same-day visits in the order they
  // actually happened.
  const { data, error } = await supabaseClient
    .from("Visit")
    .select("*")
    .eq("clinicId", clinicId)
    .eq("patientId", patientId)
    .order("visitDate", { ascending: false })
    .order("createdAt", { ascending: false });
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

// Deliberately excludes clinicId/patientId/doctorId/appointmentId/visitDate
// (identity — never client-settable on an update) and prescription (no
// current caller writes it through this general-purpose PATCH; the live
// prescription feature renders a PDF client-side and attaches it via
// POST /:id/attachments instead — see patients/[id]/page.tsx). A QA audit
// (2026-08-26/27) live-proved this route previously spread the entire
// request body into the DB write with zero allowlist and zero role check,
// so any authenticated staff member — not just a doctor — could write
// prescription content, and clinicId itself reached the write unfiltered.
// If a real API-driven prescription-editing feature is ever built, it needs
// its own doctor/owner role gate (requireRole in the route) added alongside
// re-admitting "prescription" here — not by quietly falling out of this list.
const EDITABLE_FIELDS = ["mode", "symptoms", "notes", "vitals", "followUpDate", "status"];

async function updateVisit(supabaseClient, clinicId, visitId, patch) {
  const updates = {};
  for (const field of EDITABLE_FIELDS) {
    if (field in patch) updates[field] = patch[field];
  }
  if (Object.keys(updates).length === 0) {
    throw Object.assign(new Error("No editable fields provided"), { code: "MISSING_FIELDS", statusCode: 422 });
  }

  const { data, error } = await supabaseClient
    .from("Visit")
    .update({ ...updates, updatedAt: new Date().toISOString() })
    .eq("id", visitId)
    .eq("clinicId", clinicId)
    .select()
    .maybeSingle();

  if (error) throw dbErr(`updating visit: ${error.message}`);
  if (!data)
    throw Object.assign(new Error(`Visit '${visitId}' not found`), { code: "VISIT_NOT_FOUND", statusCode: 404 });
  return data;
}

async function getVisit(supabaseClient, clinicId, visitId) {
  const { data, error } = await supabaseClient
    .from("Visit")
    .select("*")
    .eq("id", visitId)
    .eq("clinicId", clinicId)
    .maybeSingle();
  if (error) throw dbErr(`fetching visit: ${error.message}`);
  if (!data) throw Object.assign(new Error(`Visit '${visitId}' not found`), { code: "VISIT_NOT_FOUND", statusCode: 404 });
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
  if (!path || !["photo", "digital", "audio"].includes(type)) {
    throw Object.assign(new Error("path and a valid type ('photo'|'digital'|'audio') are required"), {
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

// Persists the raw recording behind a recap so it can be played back later
// (the "Recap" flow already has the audio bytes server-side, since they
// arrive as audioBase64 for Whisper transcription — this just keeps them
// instead of discarding them once the transcript is extracted). Direct
// buffer upload, not the signed-URL round trip the browser uses, since the
// bytes are already here.
async function saveAudioAttachment(supabaseClient, clinicId, visitId, buffer, contentType) {
  const path = `${clinicId}/${visitId}/${Date.now()}-recap.webm`;
  const { error: uploadErr } = await supabaseClient.storage
    .from(RX_BUCKET)
    .upload(path, buffer, { contentType: contentType ?? "audio/webm" });
  if (uploadErr) throw dbErr(`uploading audio attachment: ${uploadErr.message}`);
  return addAttachment(supabaseClient, clinicId, visitId, { path, type: "audio" });
}

// Marks one attachment (by path — the array has no other stable id) as sent,
// so a caller can safely auto-send a photo Rx exactly once on checkout
// without re-sending it every time a visit is touched again. A no-op (still
// returns the visit unchanged) if no attachment matches the given path,
// rather than throwing — the caller either just sent something that must
// have existed a moment ago, or is racing a concurrent edit; either way
// silently doing nothing to a stale path is safer than erroring the send
// that already genuinely happened.
async function markAttachmentSent(supabaseClient, clinicId, visitId, path) {
  const visit = await getVisit(supabaseClient, clinicId, visitId);
  const rxAttachments = (visit.rxAttachments ?? []).map((a) =>
    a.path === path ? { ...a, sentAt: new Date().toISOString() } : a,
  );
  const { data, error } = await supabaseClient
    .from("Visit")
    .update({ rxAttachments, updatedAt: new Date().toISOString() })
    .eq("id", visitId)
    .eq("clinicId", clinicId)
    .select()
    .maybeSingle();
  if (error) throw dbErr(`marking attachment sent: ${error.message}`);
  return data;
}

// Sends a signed link to an already-uploaded Rx attachment over
// WhatsApp/SMS and marks it sent — the one real send implementation shared
// by the doctor's explicit "Send to WhatsApp" button (api-v1-visits.js) and
// checkout's best-effort auto-send for an unsent photo Rx
// (queue-service.js's "complete" direction). Centralizing it here, rather
// than in the route, is what lets a non-HTTP caller (queue-service.js) use
// the exact same logic instead of a second copy.
async function sendAttachment(supabaseClient, twilioClient, { clinicId, visitId, path, staffId, staffContext }, log) {
  if (!twilioClient) {
    throw Object.assign(new Error("Messaging is not configured for this deployment"), {
      code: "MESSAGING_NOT_CONFIGURED",
      statusCode: 503,
    });
  }

  const visit = await getVisit(supabaseClient, clinicId, visitId);
  const attachment = (visit.rxAttachments ?? []).find((a) => a.path === path);
  if (!attachment) {
    throw Object.assign(new Error(`No attachment at path '${path}' on this visit`), {
      code: "ATTACHMENT_NOT_FOUND",
      statusCode: 404,
    });
  }
  if (!visit.patientId) {
    throw Object.assign(new Error("This visit has no linked patient to message"), { code: "NO_PATIENT", statusCode: 422 });
  }

  const patient = await tableSvc.getPatientById(supabaseClient, clinicId, visit.patientId);
  if (!patient?.contactNumber) {
    throw Object.assign(new Error("This patient has no phone number on file"), { code: "MISSING_PHONE", statusCode: 422 });
  }

  // Never hand the caller a real Supabase Storage URL — mint a token for
  // our own /rx/:token proxy instead (see app.js + lib/rx-token.js), so the
  // only URL that ever appears in the message, in Twilio's fetch, or in any
  // log is api.schedurx.com. Twilio fetches this URL itself and re-hosts the
  // bytes as a native inline document/image preview (mediaUrl), not a
  // tappable link — fails closed if PUBLIC_API_BASE_URL isn't configured on
  // this deployment, rather than falling back to leaking the Supabase URL.
  if (!config.PUBLIC_API_BASE_URL) {
    throw Object.assign(new Error("PUBLIC_API_BASE_URL is not configured for this deployment"), {
      code: "MESSAGING_NOT_CONFIGURED",
      statusCode: 503,
    });
  }
  const token = createRxToken({ clinicId, visitId, path });
  const mediaUrl = [`${config.PUBLIC_API_BASE_URL}/rx/${token}`];
  const firstName = (patient.fullName ?? "there").split(" ")[0];
  const label = attachment.type === "digital" ? "prescription" : "prescription photo";
  const body = `Hi ${firstName}, here's your ${label}.`;

  const thread = await messagingSvc.findOrCreateThread(supabaseClient, {
    clinicId,
    patientId: patient.id,
    contactPhone: patient.contactNumber,
  });

  // Prefers the Meta-approved "prescription_ready_v1" Content Template
  // (TWILIO_PRESCRIPTION_CONTENT_SID) when configured, since — like
  // sendDoctorUnavailableRebookNotice's template preference — it works
  // regardless of whether a 24h WhatsApp session happens to be open, unlike
  // the free-form mediaUrl send below. Only for 'digital' (PDF) attachments:
  // the approved template's media header is locked to the file type of its
  // submission sample, which was a PDF — sending a photo through it would
  // likely be rejected, so photos always use the free-form path only.
  // Falls back to free-form on any failure (unconfigured, still pending
  // Meta approval, transient Twilio error) exactly like that same precedent.
  if (attachment.type === "digital" && config.TWILIO_PRESCRIPTION_CONTENT_SID) {
    try {
      const clinic = await clinicSvc.getClinic(supabaseClient, clinicId);
      const ext = path.split(".").pop() || "pdf";
      await messagingSvc.sendReply(
        supabaseClient,
        {
          clinicId,
          threadId: thread.id,
          staffId,
          body,
          contentSid: config.TWILIO_PRESCRIPTION_CONTENT_SID,
          contentVariables: { 1: firstName, 2: label, 3: clinic?.name ?? "your clinic", 4: `${token}.${ext}` },
          staffContext,
        },
        log,
        twilioClient,
      );
      return markAttachmentSent(supabaseClient, clinicId, visitId, path);
    } catch (err) {
      log?.warn({ err, visitId, path }, "[visitSvc] prescription template send failed, falling back to free-form");
    }
  }

  await messagingSvc.sendReply(supabaseClient, { clinicId, threadId: thread.id, staffId, body, mediaUrl, staffContext }, log, twilioClient);

  return markAttachmentSent(supabaseClient, clinicId, visitId, path);
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
  getVisit,
  createUploadUrl,
  addAttachment,
  markAttachmentSent,
  sendAttachment,
  saveAudioAttachment,
  createReadUrl,
};
