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
const tableSvc = require("./table-service");
const callLogSvc = require("./call-log-service");
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

  const patient = await tableSvc.findOrCreatePatient(supabaseClient, clinicId, { phone: normalizedPhone });

  const callLog = await callLogSvc.createDeviceCallLog(supabaseClient, {
    clinicId,
    staffId,
    patientId: patient.id,
    phone: normalizedPhone,
    outcome: "info",
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

  const { sent } = await commsWorkflowSvc.sendMissedCallFollowup(supabaseClient, twilioClient, clinicId, normalizedPhone, log);
  if (sent) {
    await callLogSvc.updateCallLogOutcome(supabaseClient, callLog.id, "recovered_missed");
  }

  return { duplicate: false, callLog, patient, followUpSent: sent };
}

module.exports = { handleDeviceMissedCall };
