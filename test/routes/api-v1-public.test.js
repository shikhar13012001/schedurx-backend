const { test, describe } = require("node:test");
const assert = require("node:assert/strict");

const { normalizePhone } = require("../../src/routes/api-v1-public");

describe("normalizePhone", () => {
  test("accepts a bare 10-digit number", () => {
    assert.equal(normalizePhone("9876543210"), "+919876543210");
  });

  // Regression: a bare 10-digit number that happens to start with "91" must
  // not be mistaken for a 12-digit, country-code-prefixed number — stripping
  // "91" unconditionally left only 8 digits here, a real bug caught live
  // against the deployed public booking API.
  test("does not strip a leading 91 that is part of a genuine 10-digit number, not a country code", () => {
    assert.equal(normalizePhone("9123456780"), "+919123456780");
  });

  test("strips a genuine +91 country-code prefix", () => {
    assert.equal(normalizePhone("+919876543210"), "+919876543210");
    assert.equal(normalizePhone("919876543210"), "+919876543210");
  });

  test("strips a leading 0 (domestic dialing prefix) on an 11-digit number", () => {
    assert.equal(normalizePhone("09876543210"), "+919876543210");
  });

  test("strips non-digit formatting characters", () => {
    assert.equal(normalizePhone("+91 98765-43210"), "+919876543210");
  });

  test("rejects numbers that aren't a valid 10-digit Indian mobile number", () => {
    assert.equal(normalizePhone("12345"), null);
    assert.equal(normalizePhone("1234567890"), null); // doesn't start with 6-9
    assert.equal(normalizePhone(""), null);
    assert.equal(normalizePhone(undefined), null);
  });
});
