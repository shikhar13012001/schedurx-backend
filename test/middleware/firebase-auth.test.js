const { test, describe } = require("node:test");
const assert = require("node:assert/strict");

const { firebaseAuth } = require("../../src/middleware/firebase-auth");
const { createTableStub } = require("../helpers/supabase-table-stub");

function fakeReqRes({ authorization } = {}) {
  const req = { headers: { authorization }, log: { warn: () => {} } };
  let statusCode = null;
  let jsonBody = null;
  const res = {
    status(code) { statusCode = code; return this; },
    json(body) { jsonBody = body; return this; },
  };
  return { req, res, getStatus: () => statusCode, getBody: () => jsonBody };
}

function makeFirebaseAdminStub(decoded) {
  return {
    verifyIdToken: async () => {
      if (decoded instanceof Error) throw decoded;
      return decoded;
    },
  };
}

const CLINIC_ID = "clinic-1";
const DECODED = { uid: "fb-uid-1", email: "doc@example.com", fullName: "Dr. Rao", role: "doctor", clinicId: CLINIC_ID, doctorId: "doc-1" };

describe("firebaseAuth middleware", () => {
  test("rejects a missing/malformed Authorization header", async () => {
    const middleware = firebaseAuth(makeFirebaseAdminStub(DECODED), createTableStub({}));
    const { req, res, getStatus } = fakeReqRes({});
    let nextCalled = false;
    await middleware(req, res, () => { nextCalled = true; });
    assert.equal(getStatus(), 401);
    assert.equal(nextCalled, false);
  });

  test("rejects an invalid/expired token", async () => {
    const middleware = firebaseAuth(makeFirebaseAdminStub(new Error("bad token")), createTableStub({}));
    const { req, res, getStatus } = fakeReqRes({ authorization: "Bearer bad" });
    await middleware(req, res, () => {});
    assert.equal(getStatus(), 401);
  });

  test("rejects a token with no clinicId/role custom claims yet", async () => {
    const middleware = firebaseAuth(makeFirebaseAdminStub({ uid: "fb-uid-1" }), createTableStub({}));
    const { req, res, getStatus, getBody } = fakeReqRes({ authorization: "Bearer good" });
    await middleware(req, res, () => {});
    assert.equal(getStatus(), 403);
    assert.equal(getBody().error.code, "STAFF_NOT_ONBOARDED");
  });

  test("rejects when no Staff row exists for this firebaseUid", async () => {
    const middleware = firebaseAuth(makeFirebaseAdminStub(DECODED), createTableStub({ Staff: [] }));
    const { req, res, getStatus, getBody } = fakeReqRes({ authorization: "Bearer good" });
    await middleware(req, res, () => {});
    assert.equal(getStatus(), 403);
    assert.equal(getBody().error.code, "STAFF_NOT_ONBOARDED");
  });

  // The actual security fix: a deactivated staff member's Firebase ID token
  // otherwise stays valid (and silently refreshable) regardless of
  // Staff.isActive — this is what makes deactivation actually take effect
  // immediately rather than "whenever their token happens to expire".
  test("rejects a deactivated staff member even with a valid, correctly-claimed token", async () => {
    const supabaseClient = createTableStub({
      Staff: [{ id: "staff-1", firebaseUid: "fb-uid-1", clinicId: CLINIC_ID, role: "doctor", isActive: false }],
    });
    const middleware = firebaseAuth(makeFirebaseAdminStub(DECODED), supabaseClient);
    const { req, res, getStatus, getBody } = fakeReqRes({ authorization: "Bearer good" });
    let nextCalled = false;
    await middleware(req, res, () => { nextCalled = true; });
    assert.equal(getStatus(), 403);
    assert.equal(getBody().error.code, "STAFF_DEACTIVATED");
    assert.equal(nextCalled, false);
  });

  test("attaches req.staff and calls next() for an active staff member", async () => {
    const supabaseClient = createTableStub({
      Staff: [{ id: "staff-1", firebaseUid: "fb-uid-1", clinicId: CLINIC_ID, role: "doctor", isActive: true }],
    });
    const middleware = firebaseAuth(makeFirebaseAdminStub(DECODED), supabaseClient);
    const { req, res } = fakeReqRes({ authorization: "Bearer good" });
    let nextCalled = false;
    await middleware(req, res, () => { nextCalled = true; });
    assert.equal(nextCalled, true);
    assert.equal(req.staff.staffId, "staff-1");
    assert.equal(req.staff.clinicId, CLINIC_ID);
  });

  // A Staff row from before isActive existed / was never explicitly set —
  // isActive is undefined, not false, and must not be treated as deactivated.
  test("treats an undefined isActive as active (not a deactivation)", async () => {
    const supabaseClient = createTableStub({
      Staff: [{ id: "staff-1", firebaseUid: "fb-uid-1", clinicId: CLINIC_ID, role: "doctor" }],
    });
    const middleware = firebaseAuth(makeFirebaseAdminStub(DECODED), supabaseClient);
    const { req, res } = fakeReqRes({ authorization: "Bearer good" });
    let nextCalled = false;
    await middleware(req, res, () => { nextCalled = true; });
    assert.equal(nextCalled, true);
  });
});
