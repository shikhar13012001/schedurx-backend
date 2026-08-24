// Turns appointment-lifecycle events into configured patient-facing WhatsApp/
// SMS sends — driven entirely by Clinic.settings.communication, no fixed
// message text, channel, or schedule anywhere in this file.
//
// Clinic.settings.communication shape:
//   {
//     channelsEnabled: ["sms", "whatsapp"],
//     voiceGreetingTemplate: "...",              // used by webhooks-twilio.js
//     workflows: [
//       {
//         id, trigger, channel, offsetMinutes, template, enabled,
//         // Optional — set once a Meta-approved WhatsApp Content Template
//         // exists for this workflow. Required for any business-initiated
//         // WhatsApp send (see sendTemplatedMessage in messaging-service.js);
//         // `template` above becomes an unused fallback once this is set.
//         contentSid,          // e.g. "HX...", from Twilio Content Template Builder
//         contentVariables,    // ordered `data` keys -> template's {{1}},{{2}},...
//       },
//     ],
//   }
// `data`'s well-known keys include a `doctorAndClinic` convenience field
// (computed in sendAndTrack, not caller-supplied) combining doctorName +
// clinicName into one string — kept so a template can reference "who and
// where" as a single variable instead of two, for Meta's variable-density
// review.
// trigger is one of: booking_confirmed | reschedule | cancellation (fire
// immediately, synchronously, the moment the action happens) or
// reminder | pre_appointment | post_appointment | review_request (fire later,
// via a nettu-scheduler reminder — offsetMinutes is relative to the
// appointment's start; positive = after start, so a "2h after it ends"
// workflow on a 30-minute slot would use offsetMinutes: 150).
//
// Delayed workflows ride the exact same nettu reminders-array mechanism
// already proven for task reminders — no new scheduler. Their identifier is
// "<appointmentId>::<workflowId>" (vs. the plain appointmentId the existing
// staff -15min reminder uses) so webhooks-nettu.js can tell the two apart
// without the new patient-facing workflows ever spamming extra staff
// Notifications.

const { makeId } = require("../lib/ids");
const clinicSvc = require("./clinic-service");
const messagingSvc = require("./messaging-service");
const { formatHumanTime } = require("./availability-service");

const IMMEDIATE_TRIGGERS = new Set(["booking_confirmed", "reschedule", "cancellation"]);
const DELAYED_TRIGGERS = new Set(["reminder", "pre_appointment", "post_appointment", "review_request"]);

// wa.me deep link into this booking's own Thread (Phase 4's booking-ID fast
// path in webhooks-twilio.js) — the {{textCommsUrl}} a workflow template can
// reference. null when the clinic has no WhatsApp sender configured at all,
// same "quietly omit, don't break the send" posture as bookingUrlFor in
// appointment-service.js.
function buildTextCommsUrl(clinic, appointmentId) {
  const digits = clinic?.whatsappFrom?.replace(/\D/g, "");
  return digits ? `https://wa.me/${digits}?text=${encodeURIComponent(`BOOKING ${appointmentId}`)}` : null;
}

function enabledWorkflowsFor(clinic, triggers) {
  const comms = clinic?.settings?.communication ?? {};
  const channelsEnabled = comms.channelsEnabled ?? [];
  return (comms.workflows ?? []).filter(
    (w) => w?.enabled && triggers.has(w.trigger) && channelsEnabled.includes(w.channel),
  );
}

// Extra nettu reminders-array entries for this appointment's delayed
// workflows — appended alongside (not replacing) the existing staff -15min
// entry in appointment-service.js.
function buildDelayedReminderEntries(clinic, appointmentId) {
  return enabledWorkflowsFor(clinic, DELAYED_TRIGGERS).map((w) => ({
    delta: w.offsetMinutes ?? 0,
    identifier: `${appointmentId}::${w.id}`,
  }));
}

async function recordReminder(supabaseClient, { appointmentId, type, channel, status, sentAt }) {
  const { error } = await supabaseClient.from("Reminder").insert({
    id: makeId("rem"),
    appointmentId,
    type,
    channel,
    scheduledAt: new Date().toISOString(),
    sentAt: sentAt ?? null,
    status,
  });
  // A duplicate (appointmentId, type) is fine to swallow — it just means this
  // workflow already has a tracking row (e.g. a genuine race), not an error
  // worth surfacing to the caller of an appointment action.
  if (error && !/duplicate|unique/i.test(error.message ?? "")) {
    throw Object.assign(new Error(`DB error recording reminder: ${error.message}`), {
      code: "DATABASE_ERROR",
      statusCode: 500,
    });
  }
}

async function sendAndTrack({ supabaseClient, twilioClient, workflow, appointmentId, toPhone, data, clinicId }, log) {
  const from = workflow.channel === "whatsapp" ? data?.clinicWhatsappFrom : undefined;
  // Combined convenience variable for Content Templates — Meta's per-template
  // variable-density review (see webhooks-twilio.js's neighboring docs) means
  // templates are kept to few variables, so doctor+clinic are folded into one
  // rather than templates carrying both separately.
  const fullData = {
    ...data,
    doctorAndClinic:
      data?.doctorName && data?.clinicName
        ? `${data.doctorName} at ${data.clinicName}`
        : data?.doctorName || data?.clinicName || "",
  };
  try {
    await messagingSvc.sendTemplatedMessage(
      {
        twilioClient,
        channel: workflow.channel,
        toPhone,
        from,
        template: workflow.template,
        contentSid: workflow.contentSid,
        contentVariables: workflow.contentVariables,
        data: fullData,
        clinicId,
        purpose: workflow.trigger,
      },
      log,
    );
    await recordReminder(supabaseClient, {
      appointmentId,
      type: workflow.id,
      channel: workflow.channel,
      status: "sent",
      sentAt: new Date().toISOString(),
    });
  } catch (err) {
    log?.error({ err, appointmentId, workflowId: workflow.id }, "[commsWorkflowSvc] send failed");
    try {
      await recordReminder(supabaseClient, {
        appointmentId,
        type: workflow.id,
        channel: workflow.channel,
        status: "failed",
      });
    } catch (recordErr) {
      log?.error(
        { err: recordErr, appointmentId, workflowId: workflow.id },
        "[commsWorkflowSvc] failed to record failed send",
      );
    }
  }
}

// Fires any configured immediate-trigger workflows (booking_confirmed,
// reschedule, cancellation) synchronously. Never throws — a messaging
// failure must never fail the appointment action it's attached to, matching
// task-service.js's maybeCreateReminderEvent precedent.
async function sendImmediateWorkflowMessages(
  { supabaseClient, twilioClient, clinic, trigger, appointmentId, toPhone, data },
  log,
) {
  if (!twilioClient || !toPhone || !IMMEDIATE_TRIGGERS.has(trigger)) return;
  const workflows = enabledWorkflowsFor(clinic, new Set([trigger]));
  const fullData = {
    ...data,
    clinicWhatsappFrom: clinic?.whatsappFrom,
    reviewUrl: clinic?.googleReviewUrl ?? null,
    textCommsUrl: buildTextCommsUrl(clinic, appointmentId),
  };
  for (const workflow of workflows) {
    await sendAndTrack({ supabaseClient, twilioClient, workflow, appointmentId, toPhone, data: fullData, clinicId: clinic?.id }, log);
  }
}

// Called from webhooks-nettu.js when a delayed workflow's nettu reminder
// fires. Looks up the clinic/workflow config fresh (not a stale snapshot
// from booking time — the clinic may have edited its templates since), and
// is dedup-safe: a second delivery of the same reminder is a no-op.
async function sendDelayedWorkflowMessage({ supabaseClient, twilioClient, clinicId, appointmentId, workflowId }, log) {
  const { data: existing, error: existingErr } = await supabaseClient
    .from("Reminder")
    .select("id")
    .eq("appointmentId", appointmentId)
    .eq("type", workflowId)
    .maybeSingle();
  if (existingErr)
    throw Object.assign(new Error(`DB error checking reminder: ${existingErr.message}`), { code: "DATABASE_ERROR" });
  if (existing) {
    log?.info(
      { appointmentId, workflowId },
      "[commsWorkflowSvc] reminder already processed — skipping duplicate delivery",
    );
    return;
  }

  if (!twilioClient) return;

  const clinic = await clinicSvc.getClinic(supabaseClient, clinicId);
  const workflow = (clinic?.settings?.communication?.workflows ?? []).find((w) => w.id === workflowId);
  if (!workflow?.enabled) return;
  const channelsEnabled = clinic?.settings?.communication?.channelsEnabled ?? [];
  if (!channelsEnabled.includes(workflow.channel)) return;

  const { data: appointment } = await supabaseClient
    .from("Appointment")
    .select("patientId, doctorId, timeslot, symptoms")
    .eq("id", appointmentId)
    .maybeSingle();
  if (!appointment?.patientId) return; // blocked-time entries have no patient — nothing to message

  const [{ data: patient }, { data: doctor }] = await Promise.all([
    supabaseClient.from("Patient").select("fullName, contactNumber").eq("id", appointment.patientId).maybeSingle(),
    appointment.doctorId
      ? supabaseClient.from("Doctor").select("fullName").eq("id", appointment.doctorId).maybeSingle()
      : { data: null },
  ]);
  if (!patient?.contactNumber) return;

  const timezone = clinicSvc.getSchedulingRules(clinic ?? {}).timezone;
  const data = {
    clinicName: clinic?.name,
    clinicPhone: clinic?.phone,
    doctorName: doctor?.fullName,
    patientName: patient.fullName,
    apptTime: appointment.timeslot ? formatHumanTime(new Date(appointment.timeslot).getTime(), timezone) : null,
    symptoms: appointment.symptoms,
    clinicWhatsappFrom: clinic?.whatsappFrom,
    reviewUrl: clinic?.googleReviewUrl ?? null,
    textCommsUrl: buildTextCommsUrl(clinic, appointmentId),
  };
  await sendAndTrack(
    { supabaseClient, twilioClient, workflow, appointmentId, toPhone: patient.contactNumber, data, clinicId: clinic?.id },
    log,
  );
}

module.exports = { buildDelayedReminderEntries, sendImmediateWorkflowMessages, sendDelayedWorkflowMessage, buildTextCommsUrl };
