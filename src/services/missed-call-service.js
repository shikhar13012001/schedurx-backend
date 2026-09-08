// Android companion-app missed-call path — a staff phone's own native call
// log reports an unanswered call from an unknown (or explicitly whitelisted)
// caller, and this turns that into the same auto-create-lead + WhatsApp
// follow-up behavior the Twilio carrier-forwarding path already has. See
// api-v1-device-calls.js (the route this is called from), call-log-service.js
// (createDeviceCallLog's idempotency), and comms-workflow-service.js's
// sendMissedCallFollowup (the send logic shared with the Twilio path).
//
// Deliberately kept separate from comms-workflow-service.js: that file owns
// appointment-lifecycle workflow logic (booking/reminder/reschedule/etc.);
// this is a distinct call-detection entrypoint that happens to reuse one of
// its functions, not another lifecycle trigger.

const { normalizeIndianMobile } = require("../lib/phone");
const { config } = require("../config");
const tableSvc = require("./table-service");
const callLogSvc = require("./call-log-service");
const staffSvc = require("./staff-service");
const commsWorkflowSvc = require("./comms-workflow-service");

// `phone` here is whatever the Android app read off the device's own call
// log — normalized at this boundary like every other phone-number entry
// point in this codebase (see lib/phone.js's header comment).
async function handleDeviceMissedCall(supabaseClient, twilioClient, { clinicId, staffId, phone, deviceCallTimestamp }, log) {
  const normalizedPhone = normalizeIndianMobile(phone);
  if (!normalizedPhone) {
    throw Object.assign(new Error("phone is not a valid Indian mobile number"), {
      code: "INVALID_PHONE",
      statusCode: 422,
    });
  }

  // source: 'missed_call' only takes effect if this creates a NEW Patient
  // row — findOrCreatePatient never re-flags an existing one, so a real
  // patient who happens to also miss a call is never mislabeled "captured".
  const patient = await tableSvc.findOrCreatePatient(supabaseClient, clinicId, { phone: normalizedPhone, source: "missed_call" });

  const callLog = await callLogSvc.createDeviceCallLog(supabaseClient, {
    clinicId,
    staffId,
    patientId: patient.id,
    phone: normalizedPhone,
    name: patient.fullName || null,
    summary: "Missed call detected on staff phone — reported by the ScheduRx app.",
    outcome: "missed_logged",
    deviceCallTimestamp,
  });
  if (!callLog) {
    // Already recorded — a WorkManager retry or a BroadcastReceiver
    // double-fire for the same on-device call. Routine, not an error; the
    // first report already ran (or is running) the follow-up send below.
    log?.info(
      { clinicId, phone: normalizedPhone, deviceCallTimestamp },
      "[missedCallSvc] duplicate device missed-call report — already processed",
    );
    return { duplicate: true, patient };
  }

  // DEVICE_MISSED_CALL_SEND_FOLLOWUP gates only this path — the Twilio
  // carrier-forwarding path's own follow-up send is unconditional. Off by
  // default so the on-device detection pipeline can be validated (CallLog
  // row + Patient auto-create) without messaging real patients while testing.
  let sent = false;
  if (config.DEVICE_MISSED_CALL_SEND_FOLLOWUP) {
    // Only resolves a doctor when this staff member's own account is linked
    // to one (Staff.doctorId) — null for a receptionist or a doctor with no
    // link set, which sendMissedCallFollowup already falls back to
    // clinic-level attribution for.
    const staff = staffId ? await staffSvc.getStaffById(supabaseClient, staffId) : null;
    const result = await commsWorkflowSvc.sendMissedCallFollowup(
      supabaseClient,
      twilioClient,
      clinicId,
      normalizedPhone,
      log,
      staff?.doctorId ?? null,
      callLog.id,
    );
    sent = result.sent;
    if (sent) {
      await callLogSvc.updateCallLogOutcome(supabaseClient, callLog.id, "recovered_missed", "WhatsApp follow-up sent.");
    } else if (result.rateLimited) {
      await callLogSvc.updateCallLogOutcome(
        supabaseClient,
        callLog.id,
        "missed_logged",
        `Not sent — already messaged this number in the last ${config.MISSED_CALL_FOLLOWUP_COOLDOWN_HOURS}h.`,
      );
    }
  } else {
    log?.info(
      { clinicId, phone: normalizedPhone, deviceCallTimestamp },
      "[missedCallSvc] logging only — DEVICE_MISSED_CALL_SEND_FOLLOWUP is off, no WhatsApp send",
    );
  }

  return { duplicate: false, callLog, patient, followUpSent: sent };
}

module.exports = { handleDeviceMissedCall };
