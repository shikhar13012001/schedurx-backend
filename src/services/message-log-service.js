// Delivery status tracking for outbound Twilio sends — see
// supabase/migrations/20260825_message_log.sql for why this exists.

const { makeId } = require("../lib/ids");

// Called from twilio-client.js's onMessageSent hook right after a send
// succeeds — never allowed to throw back into the send path itself (a
// logging failure must not look like a message-send failure), so callers
// wrap this in a .catch(), matching this codebase's other fire-and-forget
// side-effect calls (e.g. notification-service.js's createNotification from
// a booking action).
async function recordSent(supabaseClient, { sid, clinicId, channel, toPhone, purpose, initialStatus }) {
  const now = new Date().toISOString();
  const { error } = await supabaseClient.from("MessageLog").insert({
    id: makeId("msglog"),
    clinicId: clinicId ?? null,
    providerSid: sid,
    channel,
    toPhone: toPhone ?? null,
    purpose: purpose ?? null,
    status: initialStatus ?? "queued",
    createdAt: now,
    updatedAt: now,
  });
  if (error) throw Object.assign(new Error(`DB error recording message log: ${error.message}`), { code: "DATABASE_ERROR" });
}

// Called from the /webhooks/twilio/message-status route as Twilio reports
// status transitions (queued -> sent -> delivered/undelivered/failed, or
// -> read for WhatsApp). A callback for a sid we never logged (e.g. a send
// from before this migration, or from a code path not yet wired to
// recordSent) is a silent no-op, not an error — Twilio still expects 200.
async function updateStatus(supabaseClient, { sid, status, errorCode, errorMessage }) {
  const { error } = await supabaseClient
    .from("MessageLog")
    .update({ status, errorCode: errorCode ?? null, errorMessage: errorMessage ?? null, updatedAt: new Date().toISOString() })
    .eq("providerSid", sid);
  if (error) throw Object.assign(new Error(`DB error updating message log: ${error.message}`), { code: "DATABASE_ERROR" });
}

// Recent undelivered/failed messages — the data behind a "delivery
// failures" view (dashboard surface is a follow-up; this is the query it'll
// call). clinicId null means platform-wide (an ops/health view).
async function listRecentFailures(supabaseClient, { clinicId, sinceMinutes = 1440, limit = 50 } = {}) {
  let query = supabaseClient
    .from("MessageLog")
    .select("*")
    .in("status", ["undelivered", "failed"])
    .gte("createdAt", new Date(Date.now() - sinceMinutes * 60_000).toISOString())
    .order("createdAt", { ascending: false })
    .limit(limit);
  if (clinicId) query = query.eq("clinicId", clinicId);
  const { data, error } = await query;
  if (error) throw Object.assign(new Error(`DB error listing message failures: ${error.message}`), { code: "DATABASE_ERROR" });
  return data ?? [];
}

module.exports = { recordSent, updateStatus, listRecentFailures };
