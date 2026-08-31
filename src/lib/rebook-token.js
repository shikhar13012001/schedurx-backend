// Signed, expiring tokens for the "no active booking yet" self-service
// rebook link sent over WhatsApp/SMS on non-AI plans. Deliberately NOT the
// patient's raw phone number embedded in the URL (the previous shape,
// `.../clinicId/+91XXXXXXXXXX`) — a phone number is guessable/enumerable,
// so that link let anyone who could construct a similar URL land on
// another patient's booking-management entry point. This is a fresh,
// unguessable, time-boxed token instead: HMAC-signed (can't be forged
// without INTERNAL_API_KEY), carries its own expiry, and is generated new
// each time a message goes out rather than being a stable, reusable value.
//
// Stateless by design (no new table/migration) — the token itself carries
// everything needed to verify it, checked against a fresh HMAC each time.

const crypto = require("node:crypto");
const { config } = require("../config");

const TOKEN_TTL_MS = 48 * 60 * 60 * 1000; // 48h — long enough to be useful, short enough that a leaked link goes stale

function signingKey() {
  // A distinct sub-key derived from INTERNAL_API_KEY via HMAC, not the raw
  // secret itself — the same key must never do double duty across two
  // different security purposes.
  return crypto.createHmac("sha256", config.INTERNAL_API_KEY).update("rebook-token-v1").digest();
}

function base64url(buf) {
  return Buffer.from(buf).toString("base64url");
}

// Returns an opaque token string, or null if there's nothing to point it
// at (no phone). clinicId + phone are the only claims — same capability
// model as every other public route in this codebase (id + clinic
// together), just delivered as a signed token instead of two plain path
// segments.
function createRebookToken({ clinicId, phone }) {
  if (!clinicId || !phone) return null;
  const expiresAt = Date.now() + TOKEN_TTL_MS;
  const payload = base64url(JSON.stringify({ clinicId, phone, expiresAt }));
  const signature = base64url(crypto.createHmac("sha256", signingKey()).update(payload).digest());
  return `${payload}.${signature}`;
}

// Returns { clinicId, phone } if the token is validly signed and not
// expired, otherwise null. Never throws — malformed input is expected
// (anyone can hit this endpoint with garbage) and should fail closed, not
// crash the request.
function verifyRebookToken(token) {
  if (typeof token !== "string" || !token.includes(".")) return null;
  const [payload, signature] = token.split(".");
  if (!payload || !signature) return null;

  let expectedSig;
  try {
    expectedSig = base64url(crypto.createHmac("sha256", signingKey()).update(payload).digest());
  } catch {
    return null;
  }
  const a = Buffer.from(signature);
  const b = Buffer.from(expectedSig);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;

  let claims;
  try {
    claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  if (!claims?.clinicId || !claims?.phone || typeof claims.expiresAt !== "number") return null;
  if (Date.now() > claims.expiresAt) return null;
  return { clinicId: claims.clinicId, phone: claims.phone };
}

module.exports = { createRebookToken, verifyRebookToken };
