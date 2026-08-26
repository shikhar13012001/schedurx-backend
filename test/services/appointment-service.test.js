const { test, describe } = require("node:test");
const assert = require("node:assert/strict");

const {
  bookAppointment,
  rescheduleAppointment,
  cancelAppointment,
  markCompleted,
  revertCompleted,
  markNoShow,
} = require("../../src/services/appointment-service");
const { createTableStub } = require("../helpers/supabase-table-stub");
const { createTwilioStub } = require("../helpers/twilio-stub");

// ─── Shared stubs ─────────────────────────────────────────────────────────────

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
    cancellationCutoffHours: 0, // set to 0 so tests don't hit cutoff
    rescheduleCutoffHours: 0,
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

function makeSupabase({ clinic, doctor, appointment, insertError } = {}) {
  const clinicRow = clinic ?? makeClinic();
  const doctorRow = doctor ?? makeDoctor();

  return {
    from(table) {
      const self = {
        _table: table,
        _inserts: null,
        _updates: null,
        _filters: {},
        select() {
          return this;
        },
        eq(col, val) {
          this._filters[col] = val;
          return this;
        },
        is(col, val) {
          return this;
        },
        update(data) {
          this._updates = data;
          return this;
        },
        insert(data) {
          this._inserts = data;
          return this;
        },
        async maybeSingle() {
          if (table === "Clinic") return { data: clinicRow, error: null };
          if (table === "Doctor") return { data: doctorRow, error: null };
          if (table === "Appointment") {
            return { data: appointment ?? null, error: null };
          }
          return { data: null, error: null };
        },
        async single() {
          if (table === "Appointment") {
            if (insertError) return { data: null, error: insertError };
            const row = {
              id: self._inserts?.id ?? "apt_test",
              clinicId: self._inserts?.clinicId ?? clinicRow.id,
              doctorId: self._inserts?.doctorId ?? doctorRow.id,
              timeslot: self._inserts?.timeslot ?? null,
              symptoms: self._inserts?.symptoms ?? null,
              status: self._inserts?.status ?? "booked",
              mode: self._inserts?.mode ?? "clinic",
              tokenRequested: self._inserts?.tokenRequested ?? false,
              schedulerEventId: self._inserts?.schedulerEventId ?? null,
              source: self._inserts?.source ?? "system",
              auditHistory: self._inserts?.auditHistory ?? [],
              createdAt: self._inserts?.createdAt ?? new Date().toISOString(),
              updatedAt: self._inserts?.updatedAt ?? new Date().toISOString(),
            };
            return { data: row, error: null };
          }
          return { data: self._updates ?? {}, error: null };
        },
      };
      return self;
    },
  };
}

function makeNettu({ bookingConflict = false } = {}) {
  const { NettuApiError } = require("../../src/services/nettu-client");
  return {
    async createEvent() {
      if (bookingConflict) {
        throw new NettuApiError("slot taken", 409);
      }
      return { id: "nettu-event-001" };
    },
    async deleteEvent() {
      return { id: "nettu-event-001" };
    },
  };
}

const FUTURE_START = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();

// ─── bookAppointment ──────────────────────────────────────────────────────────

describe("bookAppointment", () => {
  test("returns appointment details on success", async () => {
    const result = await bookAppointment(makeNettu(), makeSupabase(), {
      clinicId: "poc-clinic-001",
      doctorId: "doc-priya-001",
      start: FUTURE_START,
      patient: { name: "Test Patient", phone: "+919999999999" },
      source: "ultravox",
    });

    assert.equal(result.clinicId, "poc-clinic-001");
    assert.equal(result.doctorId, "doc-priya-001");
    assert.equal(result.status, "booked");
    assert.ok(result.appointmentId.startsWith("apt_"));
  });

  // Regression test: the booking form always collected consultation mode
  // and a token-payment choice, but bookAppointment silently dropped both —
  // a receptionist could pick Video + enable the token lock, see a success
  // toast, and the appointment would be created as plain in-clinic/unpaid.
  test("persists mode and tokenRequested instead of silently dropping them", async () => {
    const supabaseClient = makeSupabase();
    const result = await bookAppointment(makeNettu(), supabaseClient, {
      clinicId: "poc-clinic-001",
      doctorId: "doc-priya-001",
      start: FUTURE_START,
      patient: { name: "Test Patient", phone: "+919999999999" },
      source: "reception",
      mode: "video",
      tokenRequested: true,
    });

    assert.equal(result.mode, "video");
    assert.equal(result.tokenRequested, true);
  });

  test("defaults mode to clinic and tokenRequested to false when omitted", async () => {
    const supabaseClient = makeSupabase();
    const result = await bookAppointment(makeNettu(), supabaseClient, {
      clinicId: "poc-clinic-001",
      doctorId: "doc-priya-001",
      start: FUTURE_START,
      patient: { name: "Test Patient", phone: "+919999999999" },
      source: "reception",
    });

    assert.equal(result.mode, "clinic");
    assert.equal(result.tokenRequested, false);
  });

  test("rejects an invalid mode", async () => {
    await assert.rejects(
      bookAppointment(makeNettu(), makeSupabase(), {
        clinicId: "poc-clinic-001",
        doctorId: "doc-priya-001",
        start: FUTURE_START,
        patient: { name: "Test Patient", phone: "+919999999999" },
        source: "reception",
        mode: "carrier-pigeon",
      }),
      (err) => err.code === "INVALID_MODE",
    );
  });

  test("fires the clinic's configured booking_confirmed workflow via the real twilioClient wiring", async () => {
    const supabaseClient = createTableStub({
      Clinic: [
        {
          id: "clinic-1",
          status: "active",
          name: "Nirmaya Clinic",
          phone: "+919999999999",
          schedulerServiceId: "svc-001",
          timezone: "Asia/Kolkata",
          openingHour: 9,
          closingHour: 18,
          minNoticeHours: 0,
          maxBookingWindowDays: 30,
          settings: {
            communication: {
              channelsEnabled: ["sms"],
              workflows: [
                {
                  id: "booking-conf",
                  trigger: "booking_confirmed",
                  channel: "sms",
                  enabled: true,
                  template: "Hi {{patientName}}, your appointment with {{doctorName}} at {{clinicName}} is confirmed.",
                },
              ],
            },
          },
        },
      ],
      Doctor: [
        {
          id: "doc-priya-001",
          clinicId: "clinic-1",
          fullName: "Dr. Priya",
          isActive: true,
          schedulerDoctorId: "nettu-user-001",
          schedulerCalendarId: "nettu-cal-001",
          workingHoursStart: "09:00",
          workingHoursEnd: "18:00",
        },
      ],
    });
    const twilioClient = createTwilioStub();

    await bookAppointment(
      makeNettu(),
      supabaseClient,
      {
        clinicId: "clinic-1",
        doctorId: "doc-priya-001",
        start: FUTURE_START,
        patient: { name: "Rahul", phone: "+919888888888" },
        source: "reception",
      },
      null,
      twilioClient,
    );

    assert.equal(twilioClient.calls.sendSms.length, 1);
    assert.equal(twilioClient.calls.sendSms[0].to, "+919888888888");
    assert.match(
      twilioClient.calls.sendSms[0].body,
      /Hi Rahul, your appointment with Dr\. Priya at Nirmaya Clinic is confirmed\./,
    );
    assert.equal(supabaseClient._tables.Reminder[0].type, "booking-conf");
  });

  test("throws SLOT_NOT_AVAILABLE on 409 from nettu", async () => {
    await assert.rejects(
      () =>
        bookAppointment(makeNettu({ bookingConflict: true }), makeSupabase(), {
          clinicId: "poc-clinic-001",
          doctorId: "doc-priya-001",
          start: FUTURE_START,
          source: "ultravox",
        }),
      (err) => {
        assert.equal(err.code, "SLOT_NOT_AVAILABLE");
        return true;
      },
    );
  });

  // Regression test for a live-reproduced bug (QA audit, 2026-08-26/27):
  // two concurrent bookAppointment calls for the identical doctor+slot both
  // succeeded, because the only conflict check lived inside nettu-scheduler's
  // slot-listing query, never on the write itself. The real fix is a
  // database-layer unique index (20260827_appointment_slot_uniqueness.sql)
  // that can't be exercised by an in-memory mock — this instead proves the
  // application-side half: when Postgres reports the constraint violation
  // (code 23505, simulated here), persistAppointment must translate it into
  // the normal SLOT_NOT_AVAILABLE error AND release the nettu hold the
  // losing request already created, not leave a phantom busy block behind.
  test("releases the nettu hold and throws SLOT_NOT_AVAILABLE when it loses a concurrent booking race", async () => {
    const nettu = makeNettu();
    const deleteCalls = [];
    const origDelete = nettu.deleteEvent.bind(nettu);
    nettu.deleteEvent = async (doctorSchedulerId, eventId) => {
      deleteCalls.push({ doctorSchedulerId, eventId });
      return origDelete(doctorSchedulerId, eventId);
    };

    const supabaseClient = makeSupabase({
      insertError: { code: "23505", message: 'duplicate key value violates unique constraint "appointment_doctor_active_slot_idx"' },
    });

    await assert.rejects(
      () =>
        bookAppointment(nettu, supabaseClient, {
          clinicId: "poc-clinic-001",
          doctorId: "doc-priya-001",
          start: FUTURE_START,
          patient: { name: "Test Patient", phone: "+919999999999" },
          source: "ultravox",
        }),
      (err) => {
        assert.equal(err.code, "SLOT_NOT_AVAILABLE");
        assert.equal(err.statusCode, 409);
        return true;
      },
    );

    assert.equal(deleteCalls.length, 1, "the orphaned nettu hold from the losing request must be released");
  });

  test("throws SLOT_NOT_AVAILABLE when start time is in the past", async () => {
    const pastStart = new Date(Date.now() - 60_000).toISOString();

    await assert.rejects(
      () =>
        bookAppointment(makeNettu(), makeSupabase(), {
          clinicId: "poc-clinic-001",
          doctorId: "doc-priya-001",
          start: pastStart,
          source: "ultravox",
        }),
      (err) => {
        assert.equal(err.code, "SLOT_NOT_AVAILABLE");
        return true;
      },
    );
  });

  test("throws SCHEDULER_API_ERROR when clinic schedulerServiceId is null", async () => {
    const supabase = makeSupabase({ clinic: makeClinic({ schedulerServiceId: null }) });

    await assert.rejects(
      () =>
        bookAppointment(makeNettu(), supabase, {
          clinicId: "poc-clinic-001",
          doctorId: "doc-priya-001",
          start: FUTURE_START,
          source: "ultravox",
        }),
      (err) => {
        assert.equal(err.code, "SCHEDULER_API_ERROR");
        return true;
      },
    );
  });

  test("throws DOCTOR_NOT_IN_CLINIC when doctor clinicId mismatches", async () => {
    const supabase = makeSupabase({ doctor: makeDoctor({ clinicId: "other-clinic" }) });

    await assert.rejects(
      () =>
        bookAppointment(makeNettu(), supabase, {
          clinicId: "poc-clinic-001",
          doctorId: "doc-priya-001",
          start: FUTURE_START,
          source: "ultravox",
        }),
      (err) => {
        assert.equal(err.code, "DOCTOR_NOT_IN_CLINIC");
        return true;
      },
    );
  });
});

// ─── cancelAppointment ────────────────────────────────────────────────────────

describe("cancelAppointment", () => {
  function makeAppt(overrides = {}) {
    return {
      id: "apt_abc",
      clinicId: "poc-clinic-001",
      doctorId: "doc-priya-001",
      timeslot: new Date(Date.now() + 48 * 60 * 60 * 1000).toISOString(),
      status: "booked",
      schedulerEventId: "nettu-event-001",
      auditHistory: [],
      ...overrides,
    };
  }

  // Base makeSupabase()'s chain already supports .update().eq().eq().select()
  // .maybeSingle() (each of .eq()/.select() just returns `this`) — no
  // override needed for the happy path. `loseRace: true` simulates the
  // race-guard: another request already changed this row's status between
  // cancelAppointment's read and its conditional write, so the DB's WHERE
  // no longer matches anything and maybeSingle() must resolve to no row.
  function makeSupabaseWithAppt(appt, { loseRace = false } = {}) {
    const base = makeSupabase({ appointment: appt });
    if (!loseRace) return base;
    const origFrom = base.from.bind(base);
    base.from = function (table) {
      const chain = origFrom(table);
      if (table === "Appointment") {
        const origMaybeSingle = chain.maybeSingle.bind(chain);
        chain.maybeSingle = async function () {
          if (chain._updates) return { data: null, error: null };
          return origMaybeSingle();
        };
      }
      return chain;
    };
    return base;
  }

  test("returns cancelled status", async () => {
    const result = await cancelAppointment(makeNettu(), makeSupabaseWithAppt(makeAppt()), {
      appointmentId: "apt_abc",
      clinicId: "poc-clinic-001",
      reason: "test",
      source: "ultravox",
    });

    assert.equal(result.status, "cancelled");
    assert.equal(result.appointmentId, "apt_abc");
    assert.ok(result.cancelledAt);
  });

  test("throws APPOINTMENT_ALREADY_CANCELLED for already-cancelled appointment", async () => {
    const cancelled = makeAppt({ status: "cancelled" });

    await assert.rejects(
      () =>
        cancelAppointment(makeNettu(), makeSupabaseWithAppt(cancelled), {
          appointmentId: "apt_abc",
          clinicId: "poc-clinic-001",
          source: "ultravox",
        }),
      (err) => {
        assert.equal(err.code, "APPOINTMENT_ALREADY_CANCELLED");
        return true;
      },
    );
  });

  // Regression test for a live-reproduced bug (QA audit, 2026-08-26/27):
  // two concurrent DELETE /api/v1/public/appointments/:id requests both
  // returned 200 and both would have independently sent a cancellation
  // WhatsApp notice, because the DB write wasn't conditioned on the status
  // actually still being what the initial read saw. This simulates the
  // race's outcome directly (the conditional update matches zero rows,
  // exactly as it would in Postgres once a concurrent request already won)
  // rather than trying to fire two real concurrent calls at an in-memory
  // mock, which shares no actual database to race against.
  test("does not report success (or re-send comms) when it loses a concurrent cancel race", async () => {
    await assert.rejects(
      () =>
        cancelAppointment(makeNettu(), makeSupabaseWithAppt(makeAppt(), { loseRace: true }), {
          appointmentId: "apt_abc",
          clinicId: "poc-clinic-001",
          source: "ultravox",
        }),
      (err) => {
        assert.equal(err.code, "APPOINTMENT_ALREADY_CANCELLED");
        return true;
      },
    );
  });

  test("throws APPOINTMENT_NOT_FOUND when clinicId mismatches", async () => {
    const wrongClinic = makeAppt({ clinicId: "other-clinic" });

    await assert.rejects(
      () =>
        cancelAppointment(makeNettu(), makeSupabaseWithAppt(wrongClinic), {
          appointmentId: "apt_abc",
          clinicId: "poc-clinic-001",
          source: "ultravox",
        }),
      (err) => {
        assert.equal(err.code, "APPOINTMENT_NOT_FOUND");
        return true;
      },
    );
  });

  test("throws CANCELLATION_NOT_ALLOWED within the cutoff window", async () => {
    const supabase = makeSupabaseWithAppt(
      makeAppt({ timeslot: new Date(Date.now() + 30 * 60 * 1000).toISOString() }), // 30 min away
    );
    // Override clinic to have 1-hour cutoff
    const origFrom = supabase.from.bind(supabase);
    supabase.from = (table) => {
      const chain = origFrom(table);
      if (table === "Clinic") {
        chain.maybeSingle = async () => ({
          data: makeClinic({ cancellationCutoffHours: 2 }), // 2-hour cutoff
          error: null,
        });
      }
      return chain;
    };

    await assert.rejects(
      () =>
        cancelAppointment(makeNettu(), supabase, {
          appointmentId: "apt_abc",
          clinicId: "poc-clinic-001",
          source: "ultravox",
        }),
      (err) => {
        assert.equal(err.code, "CANCELLATION_NOT_ALLOWED");
        return true;
      },
    );
  });
});

describe("markCompleted / revertCompleted", () => {
  function seed(overrides = {}) {
    return createTableStub({
      Appointment: [
        { id: "apt_1", clinicId: "clinic-1", status: "booked", auditHistory: [], ...overrides },
      ],
    });
  }

  test("flips a booked appointment to completed with an audit entry", async () => {
    const supabaseClient = seed();
    const result = await markCompleted(supabaseClient, { appointmentId: "apt_1", clinicId: "clinic-1" });
    assert.equal(result.status, "completed");
    const row = supabaseClient._tables.Appointment[0];
    assert.equal(row.status, "completed");
    assert.equal(row.auditHistory.at(-1).action, "completed");
  });

  test("is idempotent — completing an already-completed appointment doesn't error or double the audit trail", async () => {
    const supabaseClient = seed({ status: "completed", auditHistory: [{ action: "completed" }] });
    const result = await markCompleted(supabaseClient, { appointmentId: "apt_1", clinicId: "clinic-1" });
    assert.equal(result.status, "completed");
    assert.equal(supabaseClient._tables.Appointment[0].auditHistory.length, 1);
  });

  test("throws APPOINTMENT_NOT_FOUND when clinicId mismatches", async () => {
    const supabaseClient = seed({ clinicId: "other-clinic" });
    await assert.rejects(
      () => markCompleted(supabaseClient, { appointmentId: "apt_1", clinicId: "clinic-1" }),
      (err) => { assert.equal(err.code, "APPOINTMENT_NOT_FOUND"); return true; },
    );
  });

  test("revertCompleted flips a completed appointment back to booked", async () => {
    const supabaseClient = seed({ status: "completed" });
    await revertCompleted(supabaseClient, { appointmentId: "apt_1", clinicId: "clinic-1" });
    assert.equal(supabaseClient._tables.Appointment[0].status, "booked");
  });

  test("revertCompleted is a no-op (never throws) when the appointment isn't currently completed", async () => {
    const supabaseClient = seed({ status: "booked" });
    await revertCompleted(supabaseClient, { appointmentId: "apt_1", clinicId: "clinic-1" });
    assert.equal(supabaseClient._tables.Appointment[0].status, "booked");
  });

  test("revertCompleted never throws even for an unknown appointmentId", async () => {
    const supabaseClient = seed();
    await assert.doesNotReject(() => revertCompleted(supabaseClient, { appointmentId: "nope", clinicId: "clinic-1" }));
  });

  describe("with a real patient — Visit guarantee + thank-you send", () => {
    function seedClinic(overrides = {}) {
      return {
        id: "clinic-1",
        status: "active",
        name: "Nirmaya Clinic",
        phone: "+919999999999",
        timezone: "Asia/Kolkata",
        openingHour: 9,
        closingHour: 18,
        settings: {
          communication: {
            channelsEnabled: ["sms"],
            workflows: [
              {
                id: "post-visit-sms",
                trigger: "post_appointment",
                channel: "sms",
                enabled: true,
                template: "Hi {{patientName}}, thank you for visiting {{doctorName}} at {{clinicName}} today.",
              },
            ],
          },
        },
        ...overrides,
      };
    }

    function seedFull({ visits = [] } = {}) {
      return createTableStub({
        Clinic: [seedClinic()],
        Doctor: [{ id: "doc-1", clinicId: "clinic-1", fullName: "Dr. Priya" }],
        Patient: [{ id: "pat-1", clinicId: "clinic-1", fullName: "Rahul", contactNumber: "+919888888888" }],
        Appointment: [
          {
            id: "apt_1", clinicId: "clinic-1", doctorId: "doc-1", patientId: "pat-1",
            timeslot: new Date().toISOString(), symptoms: "Fever", mode: "clinic",
            status: "booked", auditHistory: [],
          },
        ],
        Visit: visits,
      });
    }

    test("creates a bare Visit row when the doctor never ran ambient capture/Recap", async () => {
      const supabaseClient = seedFull();
      const twilioClient = createTwilioStub();
      await markCompleted(supabaseClient, { appointmentId: "apt_1", clinicId: "clinic-1" }, null, twilioClient);

      const visits = supabaseClient._tables.Visit;
      assert.equal(visits.length, 1);
      assert.equal(visits[0].patientId, "pat-1");
      assert.equal(visits[0].appointmentId, "apt_1");
      assert.equal(visits[0].symptoms, "Fever");
    });

    test("reuses today's existing Visit instead of creating a duplicate when ambient capture already ran", async () => {
      const today = new Date().toISOString().slice(0, 10);
      const supabaseClient = seedFull({
        visits: [{ id: "visit_existing", clinicId: "clinic-1", patientId: "pat-1", visitDate: today, notes: "Real ambient-capture note", createdAt: new Date().toISOString() }],
      });
      const twilioClient = createTwilioStub();
      await markCompleted(supabaseClient, { appointmentId: "apt_1", clinicId: "clinic-1" }, null, twilioClient);

      const visits = supabaseClient._tables.Visit;
      assert.equal(visits.length, 1);
      assert.equal(visits[0].id, "visit_existing");
      assert.equal(visits[0].notes, "Real ambient-capture note");
    });

    test("fires the clinic's configured post_appointment thank-you workflow", async () => {
      const supabaseClient = seedFull();
      const twilioClient = createTwilioStub();
      await markCompleted(supabaseClient, { appointmentId: "apt_1", clinicId: "clinic-1" }, null, twilioClient);

      assert.equal(twilioClient.calls.sendSms.length, 1);
      assert.equal(twilioClient.calls.sendSms[0].to, "+919888888888");
      assert.match(twilioClient.calls.sendSms[0].body, /Hi Rahul, thank you for visiting Dr\. Priya at Nirmaya Clinic today\./);
    });

    test("neither a Visit-write failure nor a messaging failure blocks the completion itself", async () => {
      const supabaseClient = seedFull();
      const throwingTwilio = {
        sendSms: async () => { throw new Error("Twilio is down"); },
        sendWhatsApp: async () => { throw new Error("Twilio is down"); },
      };
      const result = await markCompleted(supabaseClient, { appointmentId: "apt_1", clinicId: "clinic-1" }, null, throwingTwilio);
      assert.equal(result.status, "completed");
      assert.equal(supabaseClient._tables.Appointment[0].status, "completed");
    });

    test("does nothing patient-related for a blocked-time entry (no patientId)", async () => {
      const supabaseClient = createTableStub({
        Clinic: [seedClinic()],
        Appointment: [{ id: "apt_block", clinicId: "clinic-1", doctorId: "doc-1", patientId: null, status: "booked", auditHistory: [] }],
        Visit: [],
      });
      const twilioClient = createTwilioStub();
      const result = await markCompleted(supabaseClient, { appointmentId: "apt_block", clinicId: "clinic-1" }, null, twilioClient);
      assert.equal(result.status, "completed");
      assert.equal(supabaseClient._tables.Visit.length, 0);
      assert.equal(twilioClient.calls.sendSms.length, 0);
    });
  });
});

describe("markNoShow", () => {
  function seedClinic(overrides = {}) {
    return {
      id: "clinic-1",
      status: "active",
      name: "Nirmaya Clinic",
      phone: "+919999999999",
      timezone: "Asia/Kolkata",
      openingHour: 9,
      closingHour: 18,
      settings: {
        communication: {
          channelsEnabled: ["sms"],
          workflows: [
            {
              id: "no-show-sms",
              trigger: "no_show",
              channel: "sms",
              enabled: true,
              template: "Hi {{patientName}}, we missed you for your {{apptTime}} appointment with {{doctorName}} at {{clinicName}}.",
            },
          ],
        },
      },
      ...overrides,
    };
  }

  function seed({ apptOverrides = {}, clinicOverrides = {} } = {}) {
    return createTableStub({
      Clinic: [seedClinic(clinicOverrides)],
      Doctor: [{ id: "doc-1", clinicId: "clinic-1", fullName: "Dr. Priya" }],
      Patient: [{ id: "pat-1", clinicId: "clinic-1", fullName: "Rahul", contactNumber: "+919888888888" }],
      Appointment: [
        {
          id: "apt_1",
          clinicId: "clinic-1",
          doctorId: "doc-1",
          patientId: "pat-1",
          timeslot: new Date(Date.now() - 30 * 60_000).toISOString(),
          status: "booked",
          auditHistory: [],
          ...apptOverrides,
        },
      ],
    });
  }

  test("flips a booked appointment to no_show, records an audit entry, and returns notification-worthy fields", async () => {
    const supabaseClient = seed();
    const twilioClient = createTwilioStub();
    const result = await markNoShow(supabaseClient, { appointmentId: "apt_1", clinicId: "clinic-1" }, null, twilioClient);

    assert.equal(result.status, "no_show");
    assert.equal(result.patientName, "Rahul");
    assert.equal(result.doctorName, "Dr. Priya");
    assert.ok(result.apptTime);
    const row = supabaseClient._tables.Appointment[0];
    assert.equal(row.status, "no_show");
    assert.equal(row.auditHistory.at(-1).action, "no_show");
  });

  test("fires the clinic's configured no_show workflow", async () => {
    const supabaseClient = seed();
    const twilioClient = createTwilioStub();
    await markNoShow(supabaseClient, { appointmentId: "apt_1", clinicId: "clinic-1" }, null, twilioClient);

    assert.equal(twilioClient.calls.sendSms.length, 1);
    assert.equal(twilioClient.calls.sendSms[0].to, "+919888888888");
    assert.match(twilioClient.calls.sendSms[0].body, /Hi Rahul, we missed you/);
  });

  test("throws APPOINTMENT_NOT_BOOKED when the appointment isn't currently booked", async () => {
    const supabaseClient = seed({ apptOverrides: { status: "cancelled" } });
    await assert.rejects(
      () => markNoShow(supabaseClient, { appointmentId: "apt_1", clinicId: "clinic-1" }, null, createTwilioStub()),
      (err) => { assert.equal(err.code, "APPOINTMENT_NOT_BOOKED"); return true; },
    );
  });

  test("throws APPOINTMENT_NOT_FOUND when clinicId mismatches", async () => {
    const supabaseClient = seed({ apptOverrides: { clinicId: "other-clinic" } });
    await assert.rejects(
      () => markNoShow(supabaseClient, { appointmentId: "apt_1", clinicId: "clinic-1" }, null, createTwilioStub()),
      (err) => { assert.equal(err.code, "APPOINTMENT_NOT_FOUND"); return true; },
    );
  });

  test("a messaging failure doesn't undo or fail the no-show confirmation itself", async () => {
    const supabaseClient = seed();
    const throwingTwilio = {
      sendSms: async () => { throw new Error("Twilio is down"); },
      sendWhatsApp: async () => { throw new Error("Twilio is down"); },
    };
    const result = await markNoShow(supabaseClient, { appointmentId: "apt_1", clinicId: "clinic-1" }, null, throwingTwilio);
    assert.equal(result.status, "no_show");
    assert.equal(supabaseClient._tables.Appointment[0].status, "no_show");
  });
});
