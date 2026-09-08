const { makeId } = require("../lib/ids");

function dbErr(msg) {
  return Object.assign(new Error(`DB error ${msg}`), { code: "DATABASE_ERROR", statusCode: 500 });
}

async function listCallLogs(supabaseClient, clinicId, { limit = 50 } = {}) {
  const { data, error } = await supabaseClient
    .from("CallLog")
    .select("*")
    .eq("clinicId", clinicId)
    .limit(limit)
    .order("createdAt", { ascending: false });
  if (error) throw dbErr(`listing call logs: ${error.message}`);
  return data ?? [];
}

// Machine-facing write, called from /tools (bearer TOOLS_API_KEY) by a future
// voice-agent integration — mirrors the shape of the CALL_LOGS mock it replaces.
async function createCallLog(
  supabaseClient,
  { clinicId, patientId, phone, name, lang, durationSec, outcome, summary, recordingUrl, twilioCallSid },
) {
  const { data: row, error } = await supabaseClient
    .from("CallLog")
    .insert({
      id: makeId("call"),
      clinicId,
      patientId: patientId ?? null,
      phone,
      name: name ?? null,
      lang: lang ?? null,
      durationSec: durationSec ?? 0,
      outcome: outcome ?? "info",
      summary: summary ?? null,
      recordingUrl: recordingUrl ?? null,
      // Only set when present — the "CallLog" table predates the
      // twilioCallSid column (needs migration 20260818_twilio_comms.sql).
      // Including the key unconditionally would break every call-log write,
      // not just Twilio ones, on a DB that hasn't had it applied.
      ...(twilioCallSid ? { twilioCallSid } : {}),
      createdAt: new Date().toISOString(),
    })
    .select()
    .single();
  if (error) throw dbErr(`creating call log: ${error.message}`);
  return row;
}

// Idempotent by Twilio CallSid — a redelivered voice webhook (Twilio retries
// on non-2xx/timeout) updates the same row instead of creating a second one.
async function upsertByTwilioCallSid(
  supabaseClient,
  { clinicId, twilioCallSid, patientId, phone, name, lang, durationSec, outcome, summary, recordingUrl },
) {
  const { data: existing, error: findErr } = await supabaseClient
    .from("CallLog")
    .select("id")
    .eq("twilioCallSid", twilioCallSid)
    .maybeSingle();
  if (findErr) throw dbErr(`looking up call log by CallSid: ${findErr.message}`);

  if (existing) {
    const { data, error } = await supabaseClient
      .from("CallLog")
      .update({
        durationSec: durationSec ?? undefined,
        outcome: outcome ?? undefined,
        summary: summary ?? undefined,
        recordingUrl: recordingUrl ?? undefined,
      })
      .eq("id", existing.id)
      .select()
      .single();
    if (error) throw dbErr(`updating call log: ${error.message}`);
    return data;
  }

  return createCallLog(supabaseClient, {
    clinicId,
    patientId,
    phone,
    name,
    lang,
    durationSec,
    outcome,
    summary,
    recordingUrl,
    twilioCallSid,
  });
}

// Called by missed-call-service.js (Android companion app path). Idempotent
// against the (clinicId, phone, deviceCallTimestamp) unique index (see
// 20260904_device_missed_calls.sql) — deviceCallTimestamp is the device's own
// CallLog.Calls.DATE (epoch ms), stable across a WorkManager retry or a
// BroadcastReceiver double-fire for the same call, unlike the Twilio path's
// twilioCallSid (that call never happens twice at the protocol level the way
// a receiver can double-deliver). Returns null on a duplicate rather than
// throwing — the caller (a duplicate report) is a routine no-op, not an error.
async function createDeviceCallLog(
  supabaseClient,
  { clinicId, staffId, patientId, phone, name, summary, durationSec, outcome, deviceCallTimestamp },
) {
  const { data: row, error } = await supabaseClient
    .from("CallLog")
    .insert({
      id: makeId("call"),
      clinicId,
      patientId: patientId ?? null,
      phone,
      name: name ?? null,
      summary: summary ?? null,
      staffId: staffId ?? null,
      durationSec: durationSec ?? 0,
      outcome: outcome ?? "missed_logged",
      source: "android_native",
      deviceCallTimestamp,
      createdAt: new Date().toISOString(),
    })
    .select()
    .single();
  if (error) {
    if (/duplicate|unique/i.test(error.message ?? "")) return null;
    throw dbErr(`creating device call log: ${error.message}`);
  }
  return row;
}

// Rate-limit check for sendMissedCallFollowup (comms-workflow-service.js) —
// shared by both missed-call paths, since a "don't message the same number
// twice in a short window" rule doesn't care which detection path found the
// call. Looks at CallLog itself rather than a separate rate-limit table:
// every successful send already stamps outcome 'recovered_missed' on a
// CallLog row, so that's already a complete, queryable send history with no
// extra state to keep in sync. Exact phone match is safe here (unlike
// Patient's suffix-tolerant lookup) since every caller into this always
// normalizes through normalizeIndianMobile first.
async function hasRecentRecoveredMissedCall(supabaseClient, clinicId, phone, sinceIso) {
  const { data, error } = await supabaseClient
    .from("CallLog")
    .select("id")
    .eq("clinicId", clinicId)
    .eq("phone", phone)
    .eq("outcome", "recovered_missed")
    .gte("createdAt", sinceIso)
    .limit(1);
  if (error) throw dbErr(`checking recent missed-call follow-ups: ${error.message}`);
  return (data ?? []).length > 0;
}

async function updateCallLogOutcome(supabaseClient, id, outcome, summary) {
  const updates = { outcome };
  if (summary !== undefined) updates.summary = summary;
  const { error } = await supabaseClient.from("CallLog").update(updates).eq("id", id);
  if (error) throw dbErr(`updating call log outcome: ${error.message}`);
}

async function listWaLogs(supabaseClient, clinicId, { limit = 50 } = {}) {
  const { data, error } = await supabaseClient
    .from("WaLog")
    .select("*")
    .eq("clinicId", clinicId)
    .limit(limit)
    .order("createdAt", { ascending: false });
  if (error) throw dbErr(`listing WhatsApp logs: ${error.message}`);
  return data ?? [];
}

module.exports = {
  listCallLogs,
  createCallLog,
  upsertByTwilioCallSid,
  createDeviceCallLog,
  hasRecentRecoveredMissedCall,
  updateCallLogOutcome,
  listWaLogs,
};
