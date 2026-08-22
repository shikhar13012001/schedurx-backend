-- StaffInvite.token was stored and looked up in plaintext — a DB read (a
-- leaked backup, a misconfigured export, an over-broad query) handed over
-- immediately-usable access grants for every still-pending invite. Hash
-- token the same way a password would be, and look it up by that hash from
-- here on (staff-invite-service.js). shortCode is deliberately left as-is:
-- it's a human-typed convenience code, not the real credential, and is
-- addressed instead by rate-limiting lookups (see the paired rate-limit
-- change), not by hashing something meant to be read aloud.
--
-- Re-hashes existing pending tokens in place with the same sha256 the
-- application now hashes with, so already-sent (not yet accepted) invite
-- links keep working — only the stored value's format changes, not which
-- token content redeems which invite.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

UPDATE "StaffInvite"
SET "token" = encode(digest("token", 'sha256'), 'hex')
WHERE length("token") != 64 OR "token" !~ '^[0-9a-f]{64}$';
