const { test, describe } = require("node:test");
const assert = require("node:assert/strict");

const {
  epochToISO,
  toDateString,
  getAvailableSlots,
  localToUtcISO,
} = require("../../src/services/availability-service");

// ─── epochToISO ───────────────────────────────────────────────────────────────

describe("epochToISO", () => {
  test("converts epoch ms to ISO string with +05:30 for Asia/Kolkata", () => {
    // 2026-06-20 09:00:00 UTC = 2026-06-20 14:30:00 +05:30
    const utcMs = Date.UTC(2026, 5, 20, 9, 0, 0);
    const result = epochToISO(utcMs, "Asia/Kolkata");
    assert.match(result, /^2026-06-20T14:30:00\+05:30$/);
  });

  test("converts epoch ms to ISO string with +00:00 for UTC", () => {
    const utcMs = Date.UTC(2026, 5, 20, 10, 0, 0);
    const result = epochToISO(utcMs, "UTC");
    assert.match(result, /^2026-06-20T10:00:00\+00:00$/);
  });
});

// ─── localToUtcISO ────────────────────────────────────────────────────────────

describe("localToUtcISO", () => {
  test("converts a local IST clock time to the correct UTC instant", () => {
    // Regression test for the assistant sending 4pm IST times that landed on
    // the wrong hour/day because the model was doing the UTC conversion itself.
    assert.equal(localToUtcISO("2026-08-18", "16:00", "Asia/Kolkata"), "2026-08-18T10:30:00.000Z");
  });

  test("round-trips back through epochToISO to the same local wall time", () => {
    const utcIso = localToUtcISO("2026-08-18", "16:00", "Asia/Kolkata");
    const backToLocal = epochToISO(new Date(utcIso).getTime(), "Asia/Kolkata");
    assert.match(backToLocal, /^2026-08-18T16:00:00\+05:30$/);
  });

  test("is a no-op offset for UTC itself", () => {
    assert.equal(localToUtcISO("2026-08-18", "16:00", "UTC"), "2026-08-18T16:00:00.000Z");
  });
});

// ─── toDateString ─────────────────────────────────────────────────────────────

describe("toDateString", () => {
  test("returns YYYY-MM-DD from ISO string", () => {
    assert.equal(toDateString("2026-06-20T10:00:00+05:30"), "2026-06-20");
  });

  test("returns null for invalid date", () => {
    assert.equal(toDateString("not-a-date"), null);
  });

  test("returns null for null input", () => {
    assert.equal(toDateString(null), null);
  });
});

// ─── getAvailableSlots ────────────────────────────────────────────────────────

describe("getAvailableSlots", () => {
  // Minimal stub factory for a Supabase client.
  function makeSupabase({ clinic = null, doctor = null } = {}) {
    const defaultClinic = {
      id: "poc-clinic-001",
      status: "active",
      schedulerServiceId: "svc-123",
      timezone: "Asia/Kolkata",
      workingDays: ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat"],
      openingHour: 9,
      closingHour: 18,
      defaultAppointmentDurationMins: 30,
      bufferMins: 5,
      minNoticeHours: 0,
      maxBookingWindowDays: 30,
      cancellationCutoffHours: 24,
      rescheduleCutoffHours: 24,
    };
    const defaultDoctor = {
      id: "doc-priya-001",
      clinicId: "poc-clinic-001",
      isActive: true,
      schedulerDoctorId: "user-abc",
      schedulerCalendarId: "cal-xyz",
      timezone: null,
      workingDaysOverride: null,
      workingHoursStart: "09:00",
      workingHoursEnd: "18:00",
      unavailableDates: [],
      slotDurationOverrideMins: null,
      bufferOverrideMins: null,
    };

    const clinicRow = clinic ?? defaultClinic;
    const doctorRow = doctor ?? defaultDoctor;

    return {
      from(table) {
        return {
          select() {
            return this;
          },
          eq(col, val) {
            if (table === "Clinic" && col === "id") this._clinicMatch = val === clinicRow.id;
            if (table === "Doctor" && col === "id") this._doctorMatch = val === doctorRow.id;
            if (table === "Doctor" && col === "clinicId") this._clinicId = val;
            return this;
          },
          async maybeSingle() {
            if (table === "Clinic") return { data: clinicRow, error: null };
            if (table === "Doctor") return { data: doctorRow, error: null };
            return { data: null, error: null };
          },
        };
      },
    };
  }

  // Stub nettu client.
  function makeNettu(slots = []) {
    return {
      async getBookingSlots() {
        return slots;
      },
    };
  }

  test("returns mapped slots with ISO times in the requested timezone", async () => {
    const nowMs = Date.now();
    const slot1Ms = nowMs + 60 * 60 * 1000; // 1 hour from now

    const { slots } = await getAvailableSlots(
      makeNettu([{ start: slot1Ms, duration: 30 * 60 * 1000 }]),
      makeSupabase(),
      { clinicId: "poc-clinic-001", doctorId: "doc-priya-001", timezone: "Asia/Kolkata" },
    );

    assert.equal(slots.length, 1);
    assert.equal(slots[0].durationMinutes, 30);
    assert.equal(slots[0].doctorId, "doc-priya-001");
    assert.equal(slots[0].clinicId, "poc-clinic-001");
    assert.match(slots[0].start, /\+05:30$/);
  });

  test("filters out past slots", async () => {
    const pastSlotMs = Date.now() - 60 * 1000; // 1 minute ago

    const { slots } = await getAvailableSlots(makeNettu([{ start: pastSlotMs, duration: 30 }]), makeSupabase(), {
      clinicId: "poc-clinic-001",
      doctorId: "doc-priya-001",
    });

    assert.equal(slots.length, 0);
  });

  test("returns empty array when nettu returns no slots", async () => {
    const { slots } = await getAvailableSlots(makeNettu([]), makeSupabase(), {
      clinicId: "poc-clinic-001",
      doctorId: "doc-priya-001",
    });

    assert.equal(slots.length, 0);
  });

  test("throws OUTSIDE_BOOKING_WINDOW for a date too far in the future", async () => {
    const farFuture = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

    await assert.rejects(
      () =>
        getAvailableSlots(makeNettu([]), makeSupabase(), {
          clinicId: "poc-clinic-001",
          doctorId: "doc-priya-001",
          date: farFuture,
        }),
      (err) => {
        assert.equal(err.code, "OUTSIDE_BOOKING_WINDOW");
        return true;
      },
    );
  });

  test("throws SCHEDULER_API_ERROR when schedulerServiceId is missing", async () => {
    const supabase = makeSupabase({
      clinic: {
        id: "poc-clinic-001",
        status: "active",
        schedulerServiceId: null, // not configured
        timezone: "Asia/Kolkata",
        defaultAppointmentDurationMins: 30,
        bufferMins: 5,
        minNoticeHours: 0,
        maxBookingWindowDays: 30,
        cancellationCutoffHours: 24,
        rescheduleCutoffHours: 24,
      },
    });

    await assert.rejects(
      () => getAvailableSlots(makeNettu([]), supabase, { clinicId: "poc-clinic-001", doctorId: "doc-priya-001" }),
      (err) => {
        assert.equal(err.code, "SCHEDULER_API_ERROR");
        return true;
      },
    );
  });
});
