-- Real team-invite lifecycle. internal-staff-onboarding.js's bootstrap route
-- requires a firebaseUid up front, which an invite-by-phone can't supply —
-- this table holds the invite until the invitee actually signs in and one
-- becomes available (see POST /internal/staff/invites/:token/accept).
CREATE TABLE "StaffInvite" (
  id text PRIMARY KEY,
  "clinicId" text NOT NULL REFERENCES "Clinic"(id),
  "invitedByStaffId" text REFERENCES "Staff"(id),
  name text,
  phone text NOT NULL,
  role text NOT NULL,
  "doctorId" text REFERENCES "Doctor"(id),
  token text NOT NULL UNIQUE,
  status text NOT NULL DEFAULT 'pending',
  "createdAt" timestamptz NOT NULL DEFAULT now(),
  "expiresAt" timestamptz,
  "acceptedAt" timestamptz
);
CREATE INDEX staff_invite_token_idx ON "StaffInvite" (token);
