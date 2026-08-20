const { test, describe } = require("node:test");
const assert = require("node:assert/strict");

const {
  normalizePhone,
  resolveOriginalDestination,
  resolveRoute,
  createPhoneRoute,
} = require("../../src/services/phone-route-service");
const { createTableStub } = require("../helpers/supabase-table-stub");

describe("normalizePhone", () => {
  test("passes through an already-E.164 number", () => {
    assert.equal(normalizePhone("+919999999999"), "+919999999999");
  });
  test("adds a leading + to a bare digit string", () => {
    assert.equal(normalizePhone("919999999999"), "+919999999999");
  });
  test("strips formatting characters", () => {
    assert.equal(normalizePhone(" +91 99999-99999 "), "+919999999999");
  });
  test("returns null for empty/missing input", () => {
    assert.equal(normalizePhone(""), null);
    assert.equal(normalizePhone(null), null);
    assert.equal(normalizePhone(undefined), null);
  });
});

describe("resolveOriginalDestination", () => {
  test("prefers ForwardedFrom when Twilio supplies it", () => {
    const req = { body: { ForwardedFrom: "+919999999999", To: "+15551234567" }, headers: {} };
    assert.equal(resolveOriginalDestination(req), "+919999999999");
  });

  test("falls back to a SIP Diversion header when ForwardedFrom is absent", () => {
    const req = {
      body: { To: "+15551234567" },
      headers: { diversion: "<sip:+918888888888@carrier.example>;reason=no-answer" },
    };
    assert.equal(resolveOriginalDestination(req), "+918888888888");
  });

  test("falls back to To as the last resort", () => {
    const req = { body: { To: "+15551234567" }, headers: {} };
    assert.equal(resolveOriginalDestination(req), "+15551234567");
  });

  test("returns null when nothing usable is present", () => {
    const req = { body: {}, headers: {} };
    assert.equal(resolveOriginalDestination(req), null);
  });
});

describe("resolveRoute", () => {
  test("resolves via PhoneNumberRoute when one exists, over the legacy Clinic.phone match", () => {
    const supabaseClient = createTableStub({
      PhoneNumberRoute: [
        { id: "route-1", clinicId: "clinic-1", doctorId: "doc-1", originalNumber: "+919999999999", isActive: true },
      ],
      Clinic: [{ id: "clinic-2", phone: "+919999999999" }], // same number, different clinic — route should win
    });

    return resolveRoute(supabaseClient, "+919999999999").then((result) => {
      assert.deepEqual(result, { clinicId: "clinic-1", doctorId: "doc-1" });
    });
  });

  test("falls back to Clinic.phone exact match when no route is registered", () => {
    const supabaseClient = createTableStub({
      PhoneNumberRoute: [],
      Clinic: [{ id: "clinic-1", phone: "+919999999999" }],
    });

    return resolveRoute(supabaseClient, "+919999999999").then((result) => {
      assert.deepEqual(result, { clinicId: "clinic-1", doctorId: null });
    });
  });

  test("ignores an inactive route", () => {
    const supabaseClient = createTableStub({
      PhoneNumberRoute: [{ id: "route-1", clinicId: "clinic-1", originalNumber: "+919999999999", isActive: false }],
      Clinic: [],
    });

    return resolveRoute(supabaseClient, "+919999999999").then((result) => {
      assert.equal(result, null);
    });
  });

  test("returns null for an unresolvable number", async () => {
    const supabaseClient = createTableStub({ PhoneNumberRoute: [], Clinic: [] });
    assert.equal(await resolveRoute(supabaseClient, "+910000000000"), null);
    assert.equal(await resolveRoute(supabaseClient, null), null);
  });
});

describe("createPhoneRoute", () => {
  test("normalizes originalNumber/twilioNumber before storing", async () => {
    const supabaseClient = createTableStub();
    const route = await createPhoneRoute(supabaseClient, {
      clinicId: "clinic-1",
      originalNumber: "91 99999 99999",
      twilioNumber: "+1 555 123 4567",
    });
    assert.equal(route.originalNumber, "+919999999999");
    assert.equal(route.twilioNumber, "+15551234567");
    assert.equal(route.isActive, true);
  });

  test("rejects a missing originalNumber", async () => {
    const supabaseClient = createTableStub();
    await assert.rejects(
      () => createPhoneRoute(supabaseClient, { clinicId: "clinic-1" }),
      (err) => {
        assert.equal(err.code, "MISSING_FIELDS");
        return true;
      },
    );
  });
});
