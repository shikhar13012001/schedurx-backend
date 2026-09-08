// Signed, expiring tokens for the "send this prescription over WhatsApp
// without ever exposing the underlying Supabase Storage URL" flow — see
// app.js's GET /rx/:token route, which verifies one of these and proxies
// the actual file bytes back itself rather than redirecting to Storage.
// A redirect would still put the raw Supabase signed URL in a Location
// header Twilio's fetcher (and, briefly, the patient's client) would see;
// proxying means api.schedurx.com is the only URL that's ever visible
// anywhere in the message.
//
// Same construction as rebook-token.js — HMAC-signed off a distinct
// sub-key (never the raw INTERNAL_API_KEY, and never rebook-token.js's own
// sub-key either, so the two token types can't be swapped for each other),
// stateless (no new table/migration), fails closed on anything malformed.

const crypto = require("node:crypto");
const { config } = require("../config");

// Generous relative to how briefly this actually needs to live (Twilio
// fetches the media once, at send time, typically within seconds) — long
// enough to comfortably absorb a delivery retry or a slow queue, short
// enough that a leaked link goes stale well within the same day.
const TOKEN_TTL_MS = 6 * 60 * 60 * 1000;

function signingKey() {
  return crypto.createHmac("sha256", config.INTERNAL_API_KEY).update("rx-token-v1").digest();
}

function base64url(buf) {
  return Buffer.from(buf).toString("base64url");
}

// clinicId + visitId + path together are the capability — same "id + clinic
// together" model as every other public route in this codebase, plus the
// specific attachment path so this token can only ever serve the one file
// it was minted for, never any other attachment on the same visit.
function createRxToken({ clinicId, visitId, path }) {
  if (!clinicId || !visitId || !path) return null;
  const expiresAt = Date.now() + TOKEN_TTL_MS;
  const payload = base64url(JSON.stringify({ clinicId, visitId, path, expiresAt }));
  const signature = base64url(crypto.createHmac("sha256", signingKey()).update(payload).digest());
  return `${payload}.${signature}`;
}

// Returns { clinicId, visitId, path } if valid and unexpired, else null.
// Never throws — this endpoint has no other auth, so malformed/garbage
// input is expected and must fail closed, not crash the request.
function verifyRxToken(token) {
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
  if (!claims?.clinicId || !claims?.visitId || !claims?.path || typeof claims.expiresAt !== "number") return null;
  if (Date.now() > claims.expiresAt) return null;
  return { clinicId: claims.clinicId, visitId: claims.visitId, path: claims.path };
}

module.exports = { createRxToken, verifyRxToken };
