// Consult threads. Outbound delivery goes through the real Twilio WhatsApp
// send (twilioClient.sendWhatsApp, same client the automated comms workflows
// use) when a twilioClient is passed in; falls back to whatsapp-client.js's
// stub when it isn't (e.g. Twilio not configured for this deployment) — same
// "absent client -> feature quietly no-ops" convention as the rest of this
// codebase's optional integrations. Persistence and response shape are
// identical either way.

const { makeId } = require("../lib/ids");
const whatsapp = require("./whatsapp-client");
const clinicSvc = require("./clinic-service");
const { renderTemplate } = require("../lib/template");

function dbErr(msg) {
  return Object.assign(new Error(`DB error ${msg}`), { code: "DATABASE_ERROR", statusCode: 500 });
}
function notFound(id) {
  return Object.assign(new Error(`Thread '${id}' not found`), { code: "THREAD_NOT_FOUND", statusCode: 404 });
}

async function listThreads(supabaseClient, clinicId, { status } = {}) {
  let query = supabaseClient.from("Thread").select("*").eq("clinicId", clinicId);
  if (status) query = query.eq("status", status);

  const { data, error } = await query.order("lastMessageAt", { ascending: false, nullsFirst: false });
  if (error) throw dbErr(`listing threads: ${error.message}`);
  return data ?? [];
}

async function getThread(supabaseClient, clinicId, threadId) {
  const { data, error } = await supabaseClient
    .from("Thread")
    .select("*")
    .eq("id", threadId)
    .eq("clinicId", clinicId)
    .maybeSingle();
  if (error) throw dbErr(`fetching thread: ${error.message}`);
  if (!data) throw notFound(threadId);
  return data;
}

async function listMessages(supabaseClient, threadId) {
  const { data, error } = await supabaseClient
    .from("ChatMsg")
    .select("*")
    .eq("threadId", threadId)
    .order("createdAt", { ascending: true });
  if (error) throw dbErr(`listing messages: ${error.message}`);
  return data ?? [];
}

async function sendReply(supabaseClient, { clinicId, threadId, staffId, body }, log, twilioClient) {
  const thread = await getThread(supabaseClient, clinicId, threadId);

  let result;
  if (twilioClient) {
    const clinic = await clinicSvc.getClinic(supabaseClient, clinicId);
    const sent = await twilioClient.sendWhatsApp({ to: thread.contactPhone, from: clinic?.whatsappFrom, body });
    result = { ok: true, stubbed: false, waMessageId: sent?.sid ?? null };
  } else {
    result = await whatsapp.sendWhatsAppMessage({ toPhone: thread.contactPhone, body }, log);
  }

  const now = new Date().toISOString();
  const { data: message, error } = await supabaseClient
    .from("ChatMsg")
    .insert({
      id: makeId("msg"),
      threadId,
      direction: "outbound",
      senderStaffId: staffId ?? null,
      body,
      status: result.stubbed ? "queued" : "sent",
      waMessageId: result.waMessageId,
      createdAt: now,
    })
    .select()
    .single();
  if (error) throw dbErr(`saving message: ${error.message}`);

  await supabaseClient.from("Thread").update({ lastMessageAt: now, updatedAt: now }).eq("id", threadId);

  await supabaseClient.from("WaLog").insert({
    id: makeId("walog"),
    clinicId,
    direction: "outbound",
    payload: { toPhone: thread.contactPhone, body, result },
    createdAt: now,
  });

  return message;
}

// Generic templated send — the entrypoint for anything that isn't a staff
// reply inside a consult Thread (missed-call follow-ups today; appointment
// reminders/confirmations once comms-workflow-service.js lands). Does not
// persist anything itself — callers own their own delivery-tracking record
// (Reminder, CallLog, etc.) since what "sent" means differs per caller.
//
// Two send modes, chosen per-workflow by whether contentSid is configured:
//   - contentSid set: sends a Meta-approved Content Template. contentVariables
//     is an ordered array of `data` keys — mapped positionally to the
//     template's {{1}}, {{2}}, ... placeholders. Required for any
//     business-initiated WhatsApp send outside a 24h user session.
//   - contentSid absent: renders `template` (free-form, {{key}} substitution)
//     into plain body text — only valid within an open WhatsApp session, or
//     for SMS (which has no session-window restriction).
async function sendTemplatedMessage(
  { twilioClient, channel, toPhone, from, template, contentSid, contentVariables, data },
  log,
) {
  if (!["sms", "whatsapp"].includes(channel)) {
    throw Object.assign(new Error(`Unsupported channel '${channel}'`), { code: "UNSUPPORTED_CHANNEL", statusCode: 422 });
  }

  if (contentSid) {
    const variables = {};
    (contentVariables ?? []).forEach((key, idx) => {
      variables[String(idx + 1)] = data?.[key] != null ? String(data[key]) : "";
    });
    const sendFn = channel === "sms" ? twilioClient.sendSms : twilioClient.sendWhatsApp;
    const result = await sendFn({ to: toPhone, from, contentSid, contentVariables: variables });
    log?.info({ toPhone, sid: result?.sid, contentSid }, `[messagingSvc] ${channel} template sent`);
    return { sent: true, providerMessageId: result?.sid ?? null };
  }

  const body = renderTemplate(template, data);
  if (!body) {
    throw Object.assign(new Error("Rendered message body is empty"), { code: "EMPTY_TEMPLATE", statusCode: 422 });
  }
  const sendFn = channel === "sms" ? twilioClient.sendSms : twilioClient.sendWhatsApp;
  const result = await sendFn({ to: toPhone, from, body });
  log?.info({ toPhone, sid: result?.sid }, `[messagingSvc] ${channel} sent`);
  return { sent: true, providerMessageId: result?.sid ?? null };
}

// Used by the inbound WhatsApp webhook (webhooks-twilio.js) to route an
// incoming patient message into the same Thread/ChatMsg inbox staff already
// use for replies — one active (non-closed) thread per contact/channel,
// matching how a support inbox normally behaves.
async function findOrCreateThread(supabaseClient, { clinicId, patientId, contactPhone, channel = "whatsapp" }) {
  const { data: existing, error: findErr } = await supabaseClient
    .from("Thread")
    .select("*")
    .eq("clinicId", clinicId)
    .eq("contactPhone", contactPhone)
    .eq("channel", channel)
    .neq("status", "closed")
    .maybeSingle();
  if (findErr) throw dbErr(`finding thread: ${findErr.message}`);
  if (existing) return existing;

  const now = new Date().toISOString();
  const { data, error } = await supabaseClient
    .from("Thread")
    .insert({
      id: makeId("thread"),
      clinicId,
      patientId: patientId ?? null,
      channel,
      contactPhone,
      status: "open",
      assignedStaffId: null,
      lastMessageAt: now,
      unreadCount: 0,
      createdAt: now,
      updatedAt: now,
    })
    .select()
    .single();
  if (error) throw dbErr(`creating thread: ${error.message}`);
  return data;
}

// Records a patient-initiated message against an already-resolved thread —
// mirrors sendReply()'s ChatMsg + Thread + WaLog shape, just for the inbound
// direction (direction: "inbound", no senderStaffId). `thread` is passed in
// (not re-fetched) so the caller's find-or-create result is reused directly.
async function recordInboundMessage(supabaseClient, { clinicId, thread, body, waMessageId }) {
  const now = new Date().toISOString();
  const { data: message, error } = await supabaseClient
    .from("ChatMsg")
    .insert({
      id: makeId("msg"),
      threadId: thread.id,
      direction: "inbound",
      senderStaffId: null,
      body,
      status: "received",
      waMessageId: waMessageId ?? null,
      createdAt: now,
    })
    .select()
    .single();
  if (error) throw dbErr(`saving inbound message: ${error.message}`);

  await supabaseClient
    .from("Thread")
    .update({ lastMessageAt: now, unreadCount: (thread.unreadCount ?? 0) + 1, updatedAt: now })
    .eq("id", thread.id);

  await supabaseClient.from("WaLog").insert({
    id: makeId("walog"),
    clinicId,
    direction: "inbound",
    payload: { contactPhone: thread.contactPhone, body, waMessageId },
    createdAt: now,
  });

  return message;
}

// Records the WhatsApp patient agent's reply (whatsapp-agent-service.js) —
// unlike sendReply(), delivery isn't a separate Twilio API call; the reply
// text is returned directly as the webhook's TwiML response, so this only
// persists it. Tries to stamp the optional ChatMsg.viaAI column (lets the
// dashboard distinguish an AI reply from a human staff reply) but falls back
// to inserting without it if that migration hasn't been applied yet, so this
// never hard-depends on the migration. PostgREST rejects an unknown insert
// column at its own schema-cache layer (message: "Could not find the 'x'
// column of 'y' in the schema cache", typically code PGRST204) rather than
// with Postgres's raw 42703 — checked by message content since the exact
// code isn't consistently set, unlike CallLog.twilioCallSid's read-path 42703.
async function recordOutboundAiMessage(supabaseClient, { clinicId, thread, body }) {
  const now = new Date().toISOString();
  const baseRow = {
    id: makeId("msg"),
    threadId: thread.id,
    direction: "outbound",
    senderStaffId: null,
    body,
    status: "sent",
    waMessageId: null,
    createdAt: now,
  };

  let { data: message, error } = await supabaseClient
    .from("ChatMsg")
    .insert({ ...baseRow, viaAI: true })
    .select()
    .single();
  if (error && /column/i.test(error.message ?? "")) {
    ({ data: message, error } = await supabaseClient.from("ChatMsg").insert(baseRow).select().single());
  }
  if (error) throw dbErr(`saving AI reply: ${error.message}`);

  await supabaseClient.from("Thread").update({ lastMessageAt: now, updatedAt: now }).eq("id", thread.id);

  await supabaseClient.from("WaLog").insert({
    id: makeId("walog"),
    clinicId,
    direction: "outbound",
    payload: { contactPhone: thread.contactPhone, body, viaAI: true },
    createdAt: now,
  });

  return message;
}

async function escalate(supabaseClient, clinicId, threadId) {
  const { data, error } = await supabaseClient
    .from("Thread")
    .update({ status: "escalated", updatedAt: new Date().toISOString() })
    .eq("id", threadId)
    .eq("clinicId", clinicId)
    .select()
    .maybeSingle();
  if (error) throw dbErr(`escalating thread: ${error.message}`);
  if (!data) throw notFound(threadId);
  return data;
}

async function markRead(supabaseClient, clinicId, threadId) {
  const { data, error } = await supabaseClient
    .from("Thread")
    .update({ unreadCount: 0, updatedAt: new Date().toISOString() })
    .eq("id", threadId)
    .eq("clinicId", clinicId)
    .select()
    .maybeSingle();
  if (error) throw dbErr(`marking thread read: ${error.message}`);
  if (!data) throw notFound(threadId);
  return data;
}

module.exports = {
  listThreads,
  getThread,
  listMessages,
  sendReply,
  sendTemplatedMessage,
  findOrCreateThread,
  recordInboundMessage,
  recordOutboundAiMessage,
  escalate,
  markRead,
};
