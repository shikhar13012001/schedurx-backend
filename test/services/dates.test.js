const { test, describe } = require("node:test");
const assert = require("node:assert/strict");

const { toUtcIso, normalizeAppointment, normalizeAppointments } = require("../../src/lib/dates");

describe("toUtcIso", () => {
  test("appends Z to a marker-less timestamp string", () => {
    assert.equal(toUtcIso("2026-08-17T04:30:00"), "2026-08-17T04:30:00Z");
  });

  test("leaves an already-Z-suffixed value unchanged", () => {
    assert.equal(toUtcIso("2026-08-17T04:30:00.000Z"), "2026-08-17T04:30:00.000Z");
  });

  test("leaves a value with an explicit offset unchanged", () => {
    assert.equal(toUtcIso("2026-08-17T10:00:00+05:30"), "2026-08-17T10:00:00+05:30");
  });

  test("passes through null/non-string values unchanged", () => {
    assert.equal(toUtcIso(null), null);
    assert.equal(toUtcIso(undefined), undefined);
  });
});

describe("normalizeAppointment", () => {
  test("stamps every naive Appointment timestamp field", () => {
    const row = {
      id: "apt_1",
      timeslot: "2026-08-17T04:30:00",
      createdAt: "2026-08-16T20:01:24.056",
      updatedAt: "2026-08-16T20:01:24.056",
      cancelledAt: null,
      symptoms: "Fever",
    };
    const normalized = normalizeAppointment(row);
    assert.equal(normalized.timeslot, "2026-08-17T04:30:00Z");
    assert.equal(normalized.createdAt, "2026-08-16T20:01:24.056Z");
    assert.equal(normalized.updatedAt, "2026-08-16T20:01:24.056Z");
    assert.equal(normalized.cancelledAt, null);
    assert.equal(normalized.symptoms, "Fever"); // untouched
  });

  test("returns null/undefined rows unchanged", () => {
    assert.equal(normalizeAppointment(null), null);
    assert.equal(normalizeAppointment(undefined), undefined);
  });
});

describe("normalizeAppointments", () => {
  test("maps an array and defaults missing input to an empty array", () => {
    const rows = [{ id: "a", timeslot: "2026-08-17T04:30:00" }];
    assert.deepEqual(normalizeAppointments(rows), [{ id: "a", timeslot: "2026-08-17T04:30:00Z" }]);
    assert.deepEqual(normalizeAppointments(undefined), []);
  });
});
