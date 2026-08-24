// One-off: swap poc-clinic-001's live communication.workflows over to the
// newly-approved "_v1" Content Templates (see the clinic-service.js commit
// this ships alongside) — a code default change only affects clinics
// onboarded from now on, it doesn't retroactively touch an existing
// clinic's already-persisted settings row, so this real clinic needed its
// own one-time update. Mirrors DEFAULT_COMMUNICATION_WORKFLOWS exactly
// (same ids, so reminder-24h-wa's already-queued nettu reminders keep
// resolving correctly — see that const's own comment for why the id can't
// change).
//
// Usage: node scripts/migrate-poc-clinic-templates.js

require("dotenv").config();
const { createClient } = require("@supabase/supabase-js");

const CLINIC_ID = "poc-clinic-001";

const WORKFLOWS = [
  {
    id: "booking-conf-sms", channel: "sms", enabled: true, trigger: "booking_confirmed", offsetMinutes: 0,
    template: "Hi {{patientName}}, your appointment with {{doctorName}} at {{clinicName}} is confirmed for {{apptTime}}. Manage it here: {{bookingUrl}}",
  },
  {
    id: "booking-conf-wa-approved", channel: "whatsapp", enabled: true, trigger: "booking_confirmed", offsetMinutes: 0,
    template: "", contentSid: "HX55d0121e571e9f5f46c83c761e09f8b8",
    contentVariables: ["patientName", "doctorAndClinic", "apptTime", "__unused4", "__unused5", "bookingUrlPath"],
  },
  {
    id: "reschedule-sms", channel: "sms", enabled: true, trigger: "reschedule", offsetMinutes: 0,
    template: "Hi {{patientName}}, your appointment with {{doctorName}} at {{clinicName}} is confirmed for {{apptTime}}. Manage it here: {{bookingUrl}}",
  },
  {
    id: "reschedule-wa-approved", channel: "whatsapp", enabled: true, trigger: "reschedule", offsetMinutes: 0,
    template: "", contentSid: "HX8c793af3afaafe39b5eed526543d75cd",
    contentVariables: ["patientName", "doctorAndClinic", "oldApptTime", "apptTime", "bookingUrlPath"],
  },
  {
    id: "cancel-sms", channel: "sms", enabled: true, trigger: "cancellation", offsetMinutes: 0,
    template: "Hi {{patientName}}, your appointment with {{doctorName}} at {{clinicName}} on {{apptTime}} has been cancelled.",
  },
  {
    id: "cancel-wa-approved", channel: "whatsapp", enabled: true, trigger: "cancellation", offsetMinutes: 0,
    template: "", contentSid: "HX5e2b312863a160a8c39195ae2b1513b6", contentVariables: ["patientName", "doctorAndClinic", "apptTime"],
  },
  {
    id: "reminder-24h-wa", channel: "whatsapp", enabled: true, trigger: "reminder", offsetMinutes: -60,
    template: "", contentSid: "HX2ef914e3ab23cde86c7ad1e870dca71a", contentVariables: ["patientName", "doctorAndClinic", "apptTime"],
  },
  {
    id: "pre-visit-wa", channel: "whatsapp", enabled: true, trigger: "pre_appointment", offsetMinutes: -1440,
    template: "", contentSid: "HX1e88fbdafc00df38d61bbfe05b9fd48c", contentVariables: ["patientName", "doctorAndClinic", "apptTime"],
  },
  {
    id: "post-visit-wa", channel: "whatsapp", enabled: true, trigger: "post_appointment", offsetMinutes: 60,
    template: "", contentSid: "HX624789d6a245a76ff112a71430a9e729", contentVariables: ["patientName", "clinicName", "clinicPhone"],
  },
  {
    id: "review-request-wa", channel: "whatsapp", enabled: true, trigger: "review_request", offsetMinutes: 180,
    template: "", contentSid: "HX42c511a86955b5531f277a4d244185b6", contentVariables: ["patientName", "clinicName"],
  },
  {
    id: "missed-call-wa", channel: "whatsapp", enabled: true, trigger: "missed_call_followup", offsetMinutes: 0,
    template: "Sorry we missed your call at {{clinicName}}! Book an appointment here: {{bookingUrl}}, or call us back at {{clinicPhone}}.",
    contentSid: "HXf5ef9c0012d304928116c210bc23a2d7", contentVariables: ["clinicName", "clinicPhone", "bookingUrlPath"],
  },
  {
    id: "missed-call-sms", channel: "sms", enabled: true, trigger: "missed_call_followup", offsetMinutes: 0,
    template: "Sorry we missed your call at {{clinicName}}! Book an appointment here: {{bookingUrl}}, or call us back at {{clinicPhone}}.",
  },
];

async function main() {
  const supabaseClient = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const { data: clinic, error: fetchErr } = await supabaseClient.from("Clinic").select("settings").eq("id", CLINIC_ID).maybeSingle();
  if (fetchErr || !clinic) throw new Error(`Could not load clinic: ${fetchErr?.message ?? "not found"}`);

  const settings = { ...clinic.settings, communication: { ...clinic.settings.communication, workflows: WORKFLOWS } };
  const { error: updateErr } = await supabaseClient.from("Clinic").update({ settings, updatedAt: new Date().toISOString() }).eq("id", CLINIC_ID);
  if (updateErr) throw new Error(`Update failed: ${updateErr.message}`);

  console.log(`[migrate] ${CLINIC_ID} now has ${WORKFLOWS.length} workflows using the new _v1 Content Templates.`);
  process.exit(0);
}

main().catch((err) => {
  console.error("[migrate] failed:", err);
  process.exit(1);
});
