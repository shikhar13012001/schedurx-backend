-- WhatsApp agent identity confirmation (Phase 6). The agent's identity is
-- resolved once, upstream, by phone match (webhooks-twilio.js) — with no way
-- to repair a wrong match mid-conversation (e.g. a shared family phone, a
-- caregiver texting on someone else's behalf). The new confirm_identity tool
-- (whatsapp-agent-tools.js) lets the agent correct which patient a thread is
-- really about, once the caller has explicitly typed a phone number or
-- booking id proving it — persisted here so the correction survives across
-- separate inbound messages (each is its own webhook invocation with no
-- shared in-memory state).

ALTER TABLE "Thread"
  ADD COLUMN IF NOT EXISTS "confirmedPatientId" text REFERENCES "Patient"(id);
