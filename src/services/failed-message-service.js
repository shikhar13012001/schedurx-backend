// Retry queue for outbound messages — see
// supabase/migrations/20260825_failed_message_retry.sql for why this
// exists and what it deliberately doesn't cover yet (only the
// comms-workflow send path — booking_confirmed/reschedule/cancellation/
// reminder/pre+post-visit/review_request — not every send site in the
// codebase).

const { makeId } = require("../lib/ids");

// 5min, 30min, 2h — enough spacing to ride out a rate limit or a brief
// Twilio/network blip without hammering the API, short enough that a
// patient-facing confirmation doesn't sit unsent for hours.
const BACKOFF_MINUTES = [5, 30, 120];

// Error codes Twilio returns for failures that will NEVER succeed on retry
// — retrying these wastes cycles and, worse, could look like spamming a
// number that's genuinely unreachable for a structural reason. Anything not
// in this list (rate limits, 5xx, network errors with no Twilio code at
// all) is treated as transient and worth one more try.
const TERMINAL_ERROR_CODES = new Set([
  "63016", // outside the WhatsApp 24h session window, no Content Template
  "63007", // channel/number not enabled for WhatsApp
  "63024", // channel not opted in
  "21211", // invalid 'To' phone number
  "21614", // 'To' number is not a valid mobile number
  "21610", // recipient unsubscribed/opted out (STOP)
  "21408", // permission to send to this region not enabled
]);

function isRetryableError(err) {
  const code = String(err?.code ?? err?.status ?? "");
  return !TERMINAL_ERROR_CODES.has(code);
}

// Called from a send failure's catch block — never throws (a failure to
// enqueue a retry must not compound the original send failure), matching
// this codebase's other fire-and-forget side-effect calls.
async function enqueue(supabaseClient, { clinicId, channel, toPhone, fromPhone, body, contentSid, contentVariables, purpose, error }, log) {
  try {
    if (!isRetryableError(error)) {
      log?.info(
        { clinicId, channel, purpose, errorCode: error?.code },
        "[failedMessageSvc] not queuing retry — terminal error, would fail again for the same reason",
      );
      return;
    }
    const now = new Date().toISOString();
    const { error: dbErr } = await supabaseClient.from("FailedMessage").insert({
      id: makeId("fmsg"),
      clinicId: clinicId ?? null,
      channel,
      toPhone,
      fromPhone: fromPhone ?? null,
      body: body ?? null,
      contentSid: contentSid ?? null,
      contentVariables: contentVariables ?? null,
      purpose: purpose ?? null,
      attempts: 0,
      status: "pending",
      lastError: error?.message ?? String(error),
      nextAttemptAt: new Date(Date.now() + BACKOFF_MINUTES[0] * 60_000).toISOString(),
      createdAt: now,
      updatedAt: now,
    });
    if (dbErr) throw dbErr;
  } catch (err) {
    log?.error({ err, clinicId, channel, purpose }, "[failedMessageSvc] failed to enqueue retry (send itself already failed separately)");
  }
}

// Run periodically (see server.js) — attempts every row whose
// nextAttemptAt has passed. Never throws; a single row's failure (or a
// crash mid-batch) must not stop the rest of the queue from being
// processed on the next tick. emailClient is optional (see
// email-service.js) — a message reaching 'exhausted' means every automatic
// retry is done and a human needs to look at it, which is exactly the kind
// of thing that otherwise sits invisible in a database table.
async function processDue(supabaseClient, twilioClient, log, emailClient) {
  if (!twilioClient) return { attempted: 0 };

  const { data: due, error } = await supabaseClient
    .from("FailedMessage")
    .select("*")
    .eq("status", "pending")
    .lte("nextAttemptAt", new Date().toISOString())
    .limit(20);
  if (error) {
    log?.error({ err: error }, "[failedMessageSvc] failed to list due retries");
    return { attempted: 0 };
  }

  let attempted = 0;
  // Collected across the whole tick and emailed as ONE summary at the end,
  // not one email per row — a burst of failures (a real Twilio/network
  // outage hitting several queued messages at once) would otherwise mean a
  // flood of separate emails landing at exactly the moment a single clear
  // signal matters most, which defeats the point of alerting in the first
  // place. Worst case with this batching is one email per processDue tick
  // (every 2 minutes — see server.js) summarizing everything that broke in
  // that window.
  const newlyExhausted = [];
  for (const row of due ?? []) {
    attempted++;
    try {
      const sendFn = row.channel === "sms" ? twilioClient.sendSms : twilioClient.sendWhatsApp;
      await sendFn({
        to: row.toPhone,
        from: row.fromPhone ?? undefined,
        body: row.body ?? undefined,
        contentSid: row.contentSid ?? undefined,
        contentVariables: row.contentVariables ?? undefined,
        clinicId: row.clinicId,
        purpose: row.purpose,
      });
      await supabaseClient
        .from("FailedMessage")
        .update({ status: "resolved", updatedAt: new Date().toISOString() })
        .eq("id", row.id);
      log?.info({ id: row.id, purpose: row.purpose, attempts: row.attempts + 1 }, "[failedMessageSvc] retry succeeded");
    } catch (err) {
      const attempts = row.attempts + 1;
      const exhausted = attempts >= row.maxAttempts || !isRetryableError(err);
      await supabaseClient
        .from("FailedMessage")
        .update({
          attempts,
          status: exhausted ? "exhausted" : "pending",
          lastError: err?.message ?? String(err),
          nextAttemptAt: exhausted ? row.nextAttemptAt : new Date(Date.now() + (BACKOFF_MINUTES[attempts] ?? BACKOFF_MINUTES.at(-1)) * 60_000).toISOString(),
          updatedAt: new Date().toISOString(),
        })
        .eq("id", row.id);
      log?.warn({ err, id: row.id, purpose: row.purpose, attempts, exhausted }, "[failedMessageSvc] retry failed");
      if (exhausted) {
        newlyExhausted.push({
          id: row.id,
          channel: row.channel,
          toPhone: row.toPhone,
          purpose: row.purpose ?? "unknown",
          clinicId: row.clinicId ?? "unknown",
          attempts,
          lastError: err?.message ?? String(err),
        });
      }
    }
  }

  if (newlyExhausted.length > 0 && emailClient) {
    try {
      await emailClient.sendAlert({
        subject: `${newlyExhausted.length} message${newlyExhausted.length > 1 ? "s" : ""} exhausted retries`,
        text: newlyExhausted
          .map(
            (m) =>
              `- ${m.channel} to ${m.toPhone} (purpose: ${m.purpose}, clinic: ${m.clinicId}, ${m.attempts} attempts)\n` +
              `  Last error: ${m.lastError}\n  FailedMessage id: ${m.id}`,
          )
          .join("\n\n"),
      });
    } catch (emailErr) {
      log?.error({ err: emailErr, count: newlyExhausted.length }, "[failedMessageSvc] failed to send batched exhaustion alert email");
    }
  }

  return { attempted, exhausted: newlyExhausted.length };
}

// Staff-facing view (api-v1-messaging.js) — everything currently queued,
// retrying, or that ran out of attempts for this clinic. 'resolved' rows
// aren't included by default (nothing to act on); pass status explicitly
// to see them anyway.
async function listForClinic(supabaseClient, { clinicId, status, limit = 50 }) {
  let query = supabaseClient.from("FailedMessage").select("*").eq("clinicId", clinicId).order("createdAt", { ascending: false }).limit(limit);
  query = status ? query.eq("status", status) : query.neq("status", "resolved");
  const { data, error } = await query;
  if (error) throw Object.assign(new Error(`DB error listing failed messages: ${error.message}`), { code: "DATABASE_ERROR", statusCode: 500 });
  return data ?? [];
}

module.exports = { isRetryableError, enqueue, processDue, listForClinic };
