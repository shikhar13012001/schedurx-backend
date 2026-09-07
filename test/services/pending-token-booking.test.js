const { test, describe } = require("node:test");
const assert = require("node:assert/strict");

const appointmentSvc = require("../../src/services/appointment-service");
const { createTableStub } = require("../helpers/supabase-table-stub");
const { createTwilioStub } = require("../helpers/twilio-stub");

// ─── Shared stubs — mirrors appointment-service.test.js's shape, but backed
// by createTableStub (supports the PendingBooking table + .lt(), which the
// existing hand-rolled makeSupabase() in that file doesn't). ────────────────

function makeClinic(overrides = {}) {
  return {
    id: "poc-clinic-001",
    status: "active",
    schedulerServiceId: "svc-001",
    timezone: "Asia/Kolkata",
    workingDays: ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat"],
    openingHour: 9,
    closingHour: 18,
    defaultAppointmentDurationMins: 30,
    bufferMins: 5,
    minNoticeHours: 0,
    maxBookingWindowDays: 30,
    cancellationCutoffHours: 0,
    rescheduleCutoffHours: 0,
    tokenMoneyEnabled: true,
    tokenAmountPaise: 20000,
    ...overrides,
  };
}

function makeDoctor(overrides = {}) {
  return {
    id: "doc-priya-001",
    clinicId: "poc-clinic-001",
    fullName: "Dr. Priya",
    isActive: true,
    schedulerDoctorId: "nettu-user-001",
    schedulerCalendarId: "nettu-cal-001",
    timezone: null,
    workingDaysOverride: null,
    workingHoursStart: "09:00",
    workingHoursEnd: "18:00",
    unavailableDates: [],
    slotDurationOverrideMins: null,
    bufferOverrideMins: null,
    ...overrides,
  };
}

function makeNettu({ deletedEventIds = [] } = {}) {
  let createCalls = 0;
  return {
    async createEvent() {
      createCalls += 1;
      return { id: "nettu-event-001" };
    },
    async deleteEvent(_doctorSchedulerId, eventId) {
      deletedEventIds.push(eventId);
      return { id: eventId };
    },
    get createCalls() {
      return createCalls;
    },
  };
}

const FUTURE_START = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();

function bookingOpts(overrides = {}) {
  return {
    clinicId: "poc-clinic-001",
    doctorId: "doc-priya-001",
    start: FUTURE_START,
    patient: { name: "Test Patient", phone: "+919999999999" },
    source: "patient_web",
    ...overrides,
  };
}

describe("createPendingTokenBooking", () => {
  test("reserves the nettu slot and parks the booking as a PendingBooking row", async () => {
    const supabaseClient = createTableStub({ Clinic: [makeClinic()], Doctor: [makeDoctor()] });
    const nettu = makeNettu();

    const result = await appointmentSvc.createPendingTokenBooking(nettu, supabaseClient, bookingOpts(), null, createTwilioStub());

    assert.equal(result.amountPaise, 20000);
    assert.ok(result.pendingBookingId.startsWith("pbk_"));
    assert.ok(result.appointmentId.startsWith("apt_"));
    assert.equal(nettu.createCalls, 1, "the slot must be reserved on nettu immediately, before payment");

    const row = supabaseClient._tables.PendingBooking[0];
    assert.equal(row.status, "pending");
    assert.equal(row.amountPaise, 20000);
    assert.equal(row.schedulerEventId, "nettu-event-001");
    assert.equal(row.bookingParams.patient.phone, "+919999999999");

    // No Appointment row yet — this is the pay-first guarantee.
    assert.equal((supabaseClient._tables.Appointment ?? []).length, 0);
  });

  test("throws TOKEN_AMOUNT_NOT_CONFIGURED when the clinic has no token amount set", async () => {
    const supabaseClient = createTableStub({
      Clinic: [makeClinic({ tokenAmountPaise: null })],
      Doctor: [makeDoctor()],
    });

    await assert.rejects(
      () => appointmentSvc.createPendingTokenBooking(makeNettu(), supabaseClient, bookingOpts(), null, null),
      (err) => err.code === "TOKEN_AMOUNT_NOT_CONFIGURED",
    );
  });
});

describe("finalizePendingBooking", () => {
  async function seedPending(overrides = {}) {
    const supabaseClient = createTableStub({ Clinic: [makeClinic()], Doctor: [makeDoctor()] });
    const nettu = makeNettu();
    const created = await appointmentSvc.createPendingTokenBooking(nettu, supabaseClient, bookingOpts(overrides), null, null);
    return { supabaseClient, nettu, created };
  }

  test("turns a pending row into a real Appointment, reusing the same appointmentId and nettu event", async () => {
    const { supabaseClient, nettu, created } = await seedPending();

    const appointment = await appointmentSvc.finalizePendingBooking(nettu, supabaseClient, created.pendingBookingId, null, createTwilioStub());

    assert.equal(appointment.appointmentId, created.appointmentId);
    assert.equal(appointment.status, "booked");
    assert.equal(appointment.tokenRequested, true);
    assert.equal(nettu.createCalls, 1, "finalizing must not create a second nettu event — the hold from createPendingTokenBooking is reused");

    const pendingRow = supabaseClient._tables.PendingBooking.find((r) => r.id === created.pendingBookingId);
    assert.equal(pendingRow.status, "completed");
  });

  // Regression coverage for a live-reported gap (2026-09-08): a real,
  // successfully collected token payment used to leave no Invoice row at
  // all, so the analytics page's revenue figure read 0 for a clinic
  // actively collecting deposits — the money was genuinely charged via
  // Stripe but invisible in the app's own data.
  test("records a paid Invoice for the collected token amount", async () => {
    const { supabaseClient, nettu, created } = await seedPending();

    const appointment = await appointmentSvc.finalizePendingBooking(
      nettu, supabaseClient, created.pendingBookingId, null, createTwilioStub(), "pi_test_123",
    );

    const invoices = supabaseClient._tables.Invoice ?? [];
    assert.equal(invoices.length, 1);
    const invoice = invoices[0];
    assert.equal(invoice.status, "paid");
    assert.equal(invoice.amountInr, 200); // amountPaise: 20000 -> 200 INR
    assert.equal(invoice.appointmentId, appointment.appointmentId);
    assert.equal(invoice.provider, "stripe");
    assert.equal(invoice.providerReference, "pi_test_123");
    assert.ok(invoice.paidAt);
  });

  test("still returns the booked appointment even if recording the Invoice itself fails", async () => {
    const { supabaseClient, nettu, created } = await seedPending();
    // Corrupt the fixture so the Invoice insert path throws (amountPaise
    // missing/invalid) without touching the booking flow at all — proves
    // this failure is genuinely best-effort, not silently masking a real
    // booking failure too.
    const pendingRow = supabaseClient._tables.PendingBooking.find((r) => r.id === created.pendingBookingId);
    pendingRow.amountPaise = 0;

    const appointment = await appointmentSvc.finalizePendingBooking(
      nettu, supabaseClient, created.pendingBookingId, { info: () => {}, warn: () => {}, error: () => {} }, createTwilioStub(), "pi_test_456",
    );
    assert.equal(appointment.status, "booked");
    assert.equal((supabaseClient._tables.Invoice ?? []).length, 0);
  });

  test("is idempotent — a second call (e.g. a Stripe webhook retry) does not double-book", async () => {
    const { supabaseClient, nettu, created } = await seedPending();

    await appointmentSvc.finalizePendingBooking(nettu, supabaseClient, created.pendingBookingId, null, null);
    const second = await appointmentSvc.finalizePendingBooking(nettu, supabaseClient, created.pendingBookingId, null, null);

    assert.equal(second, null);
    assert.equal(supabaseClient._tables.Appointment.length, 1);
  });

  test("returns null for an unknown pending booking id instead of throwing", async () => {
    const supabaseClient = createTableStub({ Clinic: [makeClinic()], Doctor: [makeDoctor()] });
    const result = await appointmentSvc.finalizePendingBooking(makeNettu(), supabaseClient, "pbk_does_not_exist", null, null);
    assert.equal(result, null);
  });

  // Regression test for a source-verified gap (QA audit, 2026-08-26/27):
  // finalizePendingBooking used to mark "completed" only at the very end,
  // after already creating the real Appointment — Stripe documents webhook
  // delivery as at-least-once, and a dashboard "resend" racing a slow
  // original delivery is a real way for this function to run twice for one
  // paid booking. The "is idempotent" test above only proves *sequential*
  // reuse is safe (call one fully finishes before call two starts, so the
  // ordinary status check alone would already catch it) — this simulates
  // the actual race: the initial read still sees "pending", but the row
  // changes between that read and this request's own claim.
  test("does not double-book if it loses the race to claim the pending booking", async () => {
    const { supabaseClient, nettu, created } = await seedPending();
    const origFrom = supabaseClient.from.bind(supabaseClient);
    supabaseClient.from = function (name) {
      const chain = origFrom(name);
      if (name === "PendingBooking") {
        const origUpdate = chain.update.bind(chain);
        chain.update = function (patch) {
          // A concurrent delivery "wins" the instant ours starts its claim.
          const row = supabaseClient._tables.PendingBooking.find((r) => r.id === created.pendingBookingId);
          if (row) row.status = "completed";
          return origUpdate(patch);
        };
      }
      return chain;
    };

    const result = await appointmentSvc.finalizePendingBooking(nettu, supabaseClient, created.pendingBookingId, null, null);

    assert.equal(result, null);
    assert.equal((supabaseClient._tables.Appointment ?? []).length, 0, "the losing request must not create its own Appointment");
  });

  // If the actual booking work fails *after* this function has already
  // claimed the row (e.g. the clinic/doctor lookup errors), the claim must
  // not leave the pending booking permanently stuck — a paid booking with
  // no appointment and no way to self-heal on the next webhook retry.
  test("reverts the pending booking back to 'pending' if booking fails after the claim succeeds", async () => {
    const { supabaseClient, nettu, created } = await seedPending();
    // Force requireActiveDoctor to fail by removing the doctor row after
    // the pending booking was created against it.
    supabaseClient._tables.Doctor = [];

    await assert.rejects(() => appointmentSvc.finalizePendingBooking(nettu, supabaseClient, created.pendingBookingId, null, null));

    const pendingRow = supabaseClient._tables.PendingBooking.find((r) => r.id === created.pendingBookingId);
    assert.equal(pendingRow.status, "pending", "a failed finalize must revert the claim so a later retry can recover");
    assert.equal((supabaseClient._tables.Appointment ?? []).length, 0);
  });
});

describe("expirePendingBookings", () => {
  test("expires a stale pending row and releases its nettu hold", async () => {
    const supabaseClient = createTableStub({
      Doctor: [makeDoctor()],
      PendingBooking: [
        {
          id: "pbk_stale",
          clinicId: "poc-clinic-001",
          doctorId: "doc-priya-001",
          schedulerEventId: "nettu-event-stale",
          status: "pending",
          expiresAt: new Date(Date.now() - 60_000).toISOString(),
        },
      ],
    });
    const deletedEventIds = [];
    const nettu = makeNettu({ deletedEventIds });

    const result = await appointmentSvc.expirePendingBookings(nettu, supabaseClient, null);

    assert.equal(result.expiredCount, 1);
    assert.deepEqual(deletedEventIds, ["nettu-event-stale"]);
    assert.equal(supabaseClient._tables.PendingBooking[0].status, "expired");
  });

  test("leaves a not-yet-expired pending row untouched", async () => {
    const supabaseClient = createTableStub({
      Doctor: [makeDoctor()],
      PendingBooking: [
        {
          id: "pbk_fresh",
          clinicId: "poc-clinic-001",
          doctorId: "doc-priya-001",
          schedulerEventId: "nettu-event-fresh",
          status: "pending",
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
        },
      ],
    });

    const result = await appointmentSvc.expirePendingBookings(makeNettu(), supabaseClient, null);

    assert.equal(result.expiredCount, 0);
    assert.equal(supabaseClient._tables.PendingBooking[0].status, "pending");
  });

  test("leaves an already-completed row untouched even if its expiresAt has passed", async () => {
    const supabaseClient = createTableStub({
      Doctor: [makeDoctor()],
      PendingBooking: [
        {
          id: "pbk_done",
          clinicId: "poc-clinic-001",
          doctorId: "doc-priya-001",
          schedulerEventId: "nettu-event-done",
          status: "completed",
          expiresAt: new Date(Date.now() - 60_000).toISOString(),
        },
      ],
    });

    const result = await appointmentSvc.expirePendingBookings(makeNettu(), supabaseClient, null);

    assert.equal(result.expiredCount, 0);
    assert.equal(supabaseClient._tables.PendingBooking[0].status, "completed");
  });
});
