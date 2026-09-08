-- Two additive columns for the missed-call recovery feature's remaining
-- scope (Captured Patient Directory section + booking attribution):
--
-- Patient.source: 'missed_call' for a Patient row auto-created by
-- findOrCreatePatient from an eligible missed call (Android device path or
-- Twilio carrier-forwarding), NULL for every other creation path (organic
-- booking, walk-in, manual entry). Drives the Patient Directory's
-- "Captured" filter — a captured lead stays flagged until a staff member
-- explicitly confirms it (clears this column) or it converts via a real
-- booking.
--
-- Appointment.sourceCallLogId: set when a booking was made through a
-- missed-call recovery link (verified via the signed token in
-- rebook-token.js's extended callLogId claim — see api-v1-public.js's
-- POST /appointments). Lets a specific missed call's CallLog outcome flip
-- to 'booked' and gives the Patient Directory/call-history UI a real,
-- non-fabricated "Appointment Booked" status instead of guessing.

ALTER TABLE "Patient" ADD COLUMN IF NOT EXISTS "source" text;
CREATE INDEX IF NOT EXISTS patient_clinic_source_idx ON "Patient" ("clinicId", "source");

ALTER TABLE "Appointment" ADD COLUMN IF NOT EXISTS "sourceCallLogId" text REFERENCES "CallLog"(id);
