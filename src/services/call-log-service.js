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

module.exports = { listCallLogs, createCallLog, upsertByTwilioCallSid, listWaLogs };
