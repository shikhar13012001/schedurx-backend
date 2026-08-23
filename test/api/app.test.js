const assert = require("node:assert/strict");
const { test } = require("node:test");

process.env.NODE_ENV = "test";
process.env.TOOLS_API_KEY = "test-tools-api-key-with-32-characters";
process.env.INTERNAL_API_KEY = "test-internal-api-key-with-32-chars";
process.env.SUPABASE_URL = "https://example.supabase.co";
process.env.SUPABASE_SERVICE_ROLE_KEY = "service-role-key";
process.env.NETTU_BASE_URL = "https://nettu.example.test";
process.env.NETTU_API_KEY = "nettu-api-key";

const { createApp } = require("../../src/app");
const { createTableStub } = require("../helpers/supabase-table-stub");
const { createFirebaseAdminStub } = require("../helpers/firebase-admin-stub");
const { createStripeStub } = require("../helpers/stripe-stub");
const { createOpenaiStub } = require("../helpers/openai-stub");
const { MockLanguageModelV4, MockLanguageModelV3, simulateReadableStream } = require("ai/test");
const { createTwilioStub } = require("../helpers/twilio-stub");

// Minimal Supabase stub: Clinic lookups miss by default, Patient lookups/creates
// return a stable row, matching the shape internal-call-context.js and the tool
// routes expect from a real Supabase client.
function createSupabaseStub({ clinic = null } = {}) {
  return {
    from(table) {
      const self = {
        _filters: {},
        select() {
          return this;
        },
        eq(col, val) {
          this._filters[col] = val;
          return this;
        },
        ilike() {
          return this;
        },
        order() {
          return this;
        },
        limit() {
          return this;
        },
        insert(data) {
          this._inserted = data;
          return this;
        },
        async maybeSingle() {
          if (table === "Clinic") return { data: clinic, error: null };
          return { data: null, error: null };
        },
        async single() {
          return { data: { id: this._inserted?.id ?? "pat_test", ...this._inserted }, error: null };
        },
      };
      return self;
    },
  };
}

async function withServer(app, run) {
  const server = app.listen(0);
  await new Promise((resolve) => server.once("listening", resolve));

  const { port } = server.address();
  const baseUrl = `http://127.0.0.1:${port}`;

  try {
    return await run({
      request: (path, options = {}) => fetch(`${baseUrl}${path}`, options),
    });
  } finally {
    await new Promise((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
}

async function readJson(response) {
  return response.json();
}

test("GET /health returns the public health contract", async () => {
  const app = createApp({ supabaseClient: createSupabaseStub(), nettuClient: null });

  await withServer(app, async ({ request }) => {
    const response = await request("/health");
    const body = await readJson(response);

    assert.equal(response.status, 200);
    assert.equal(body.ok, true);
    assert.equal(body.service, "schedurx-backend");
    assert.match(body.timestamp, /^\d{4}-\d{2}-\d{2}T/);
  });
});

test("POST /tools/debug/echo stays available without bearer auth", async () => {
  const app = createApp({ supabaseClient: createSupabaseStub(), nettuClient: null });

  await withServer(app, async ({ request }) => {
    const response = await request("/tools/debug/echo", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ testMessage: "hello" }),
    });
    const body = await readJson(response);

    assert.equal(response.status, 200);
    assert.equal(body.message, "Echo received. Check server logs for full request details.");
    assert.deepEqual(body.received.body, { testMessage: "hello" });
  });
});

test("POST /tools/* requires bearer auth", async () => {
  const app = createApp({ supabaseClient: createSupabaseStub(), nettuClient: null });

  await withServer(app, async ({ request }) => {
    const response = await request("/tools/patients/identify", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ultravoxCallId: "call-1" }),
    });
    const body = await readJson(response);

    assert.equal(response.status, 401);
    assert.deepEqual(body, { error: "Unauthorized" });
  });
});

test("POST /tools/patients/identify preserves missing context response shape", async () => {
  const app = createApp({ supabaseClient: createSupabaseStub(), nettuClient: null });

  await withServer(app, async ({ request }) => {
    const response = await request("/tools/patients/identify", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.TOOLS_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ ultravoxCallId: "call-1" }),
    });
    const body = await readJson(response);

    assert.equal(response.status, 422);
    assert.deepEqual(body, { error: "Unable to resolve clinic or caller from call context" });
  });
});

test("POST /tools/calendar/slots preserves structured calendar error shape", async () => {
  const app = createApp({
    supabaseClient: createSupabaseStub(),
    nettuClient: { getBookingSlots: async () => [] },
  });

  await withServer(app, async ({ request }) => {
    const response = await request("/tools/calendar/slots", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.TOOLS_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ ultravoxCallId: "missing-call" }),
    });
    const body = await readJson(response);

    assert.equal(response.status, 422);
    assert.deepEqual(body, {
      success: false,
      error: {
        code: "CLINIC_NOT_FOUND",
        message: `clinicId could not be resolved ${String.fromCharCode(0x2014)} call identify_patient first`,
        details: null,
      },
    });
  });
});

test("POST /tools/patients/identify resolves via static clinicId/phoneNumber body params", async () => {
  const app = createApp({
    supabaseClient: createSupabaseStub({ clinic: { id: "clinic-1" } }),
    nettuClient: null,
  });

  await withServer(app, async ({ request }) => {
    const response = await request("/tools/patients/identify", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.TOOLS_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ ultravoxCallId: "call-2", clinicId: "clinic-1", phoneNumber: "+919999999999" }),
    });
    const body = await readJson(response);

    // Patient lookup misses (stub returns null), so a new patient is created (201).
    assert.equal(response.status, 201);
    assert.equal(body.clinicId, "clinic-1");
    assert.equal(body.contactNumber, "+919999999999");
    assert.equal(body.isNew, true);
  });
});

test("POST /internal/call-context/resolve requires its own bearer auth", async () => {
  const app = createApp({ supabaseClient: createSupabaseStub(), nettuClient: null });

  await withServer(app, async ({ request }) => {
    const response = await request("/internal/call-context/resolve", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ toPhone: "+911111111111", fromPhone: "+919999999999" }),
    });
    const body = await readJson(response);

    assert.equal(response.status, 401);
    assert.deepEqual(body, { error: "Unauthorized" });

    // The tools bearer key must not also authorize the internal route.
    const wrongKey = await request("/internal/call-context/resolve", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.TOOLS_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ toPhone: "+911111111111", fromPhone: "+919999999999" }),
    });
    assert.equal(wrongKey.status, 401);
  });
});

test("POST /internal/call-context/resolve returns nulls when the clinic is unknown", async () => {
  const app = createApp({ supabaseClient: createSupabaseStub(), nettuClient: null });

  await withServer(app, async ({ request }) => {
    const response = await request("/internal/call-context/resolve", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.INTERNAL_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ toPhone: "+911111111111", fromPhone: "+919999999999" }),
    });
    const body = await readJson(response);

    assert.equal(response.status, 200);
    assert.deepEqual(body, { clinicId: null, patientId: null, isNewPatient: false });
  });
});

test("POST /internal/call-context/resolve resolves clinicId and bootstraps a patient", async () => {
  const app = createApp({
    supabaseClient: createSupabaseStub({ clinic: { id: "clinic-1" } }),
    nettuClient: null,
  });

  await withServer(app, async ({ request }) => {
    const response = await request("/internal/call-context/resolve", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.INTERNAL_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ toPhone: "+911111111111", fromPhone: "+919999999999" }),
    });
    const body = await readJson(response);

    assert.equal(response.status, 200);
    assert.equal(body.clinicId, "clinic-1");
    assert.equal(body.isNewPatient, true);
    assert.ok(body.patientId);
  });
});

// ─── New integrations: conditional-mount contract ──────────────────────────────
// Regression guard: with every new optional client absent, the app must still
// boot cleanly and every existing /tools/*, /internal/*, /health behavior above
// must be untouched — the whole point of the "mount only if configured" pattern.

test("app boots with all new optional clients absent — /api/v1 and /webhooks/stripe are unmounted", async () => {
  const app = createApp({
    supabaseClient: createSupabaseStub(),
    nettuClient: null,
    firebaseAdminApp: null,
    stripeClient: null,
    openaiClient: null,
  });

  await withServer(app, async ({ request }) => {
    const apiV1 = await request("/api/v1/me");
    assert.equal(apiV1.status, 404);

    const webhook = await request("/webhooks/stripe", { method: "POST", body: "{}" });
    assert.equal(webhook.status, 404);

    // Untouched existing behavior.
    const health = await request("/health");
    assert.equal(health.status, 200);
  });
});

test("GET /docs renders the Swagger UI regardless of optional client configuration", async () => {
  const app = createApp({ supabaseClient: createSupabaseStub(), nettuClient: null });

  await withServer(app, async ({ request }) => {
    const response = await request("/docs/");
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type") ?? "", /html/);
  });
});

// ─── /api/v1 — Firebase-authenticated dashboard REST layer ─────────────────────

test("GET /api/v1/me requires a valid Firebase token and returns the resolved staff claims", async () => {
  const firebaseAdminApp = createFirebaseAdminStub({
    decodedToken: {
      uid: "staff-1",
      email: "doc@example.com",
      fullName: "Doc Example",
      role: "doctor",
      clinicId: "clinic-1",
      doctorId: "doc-1",
    },
  });
  const app = createApp({
    supabaseClient: createTableStub({ Staff: [{ id: "staff-1", firebaseUid: "staff-1", clinicId: "clinic-1" }] }),
    nettuClient: null,
    firebaseAdminApp,
    stripeClient: null,
    openaiClient: null,
  });

  await withServer(app, async ({ request }) => {
    const noAuth = await request("/api/v1/me");
    assert.equal(noAuth.status, 401);

    const authed = await request("/api/v1/me", { headers: { Authorization: "Bearer anything" } });
    const body = await readJson(authed);
    assert.equal(authed.status, 200);
    assert.deepEqual(body.data.staff, {
      uid: "staff-1",
      staffId: "staff-1",
      email: "doc@example.com",
      fullName: "Doc Example",
      role: "doctor",
      clinicId: "clinic-1",
      doctorId: "doc-1",
    });
  });
});

test("POST /api/v1/team/invites normalizes the phone and sends WhatsApp and SMS independently", async () => {
  const { config } = require("../../src/config");
  const previousBaseUrl = config.DASHBOARD_BASE_URL;
  const previousContentSid = config.TWILIO_TEAM_INVITE_CONTENT_SID;
  config.DASHBOARD_BASE_URL = "https://app.schedurx.test";
  config.TWILIO_TEAM_INVITE_CONTENT_SID = undefined;

  const firebaseAdminApp = createFirebaseAdminStub({
    decodedToken: { uid: "staff-1", role: "doctor", clinicId: "clinic-1" },
  });
  const supabaseClient = createTableStub({
    Staff: [{ id: "staff-1", firebaseUid: "staff-1", clinicId: "clinic-1" }],
    Clinic: [{ id: "clinic-1", name: "Care Clinic", whatsappFrom: "+14155550100" }],
    StaffInvite: [],
  });
  const twilioClient = createTwilioStub();
  const app = createApp({ supabaseClient, nettuClient: null, firebaseAdminApp, twilioClient });

  try {
    await withServer(app, async ({ request }) => {
      const response = await request("/api/v1/team/invites", {
        method: "POST",
        headers: { Authorization: "Bearer anything", "Content-Type": "application/json" },
        body: JSON.stringify({ name: "Dr. Test", phone: "+91 81234-51109", role: "doctor" }),
      });
      const body = await readJson(response);

      assert.equal(response.status, 201);
      assert.equal(body.data.invite.phone, "+918123451109");
      assert.equal(twilioClient.calls.sendWhatsApp.length, 1);
      assert.equal(twilioClient.calls.sendSms.length, 1);
      assert.equal(twilioClient.calls.sendWhatsApp[0].to, "+918123451109");
      assert.equal(twilioClient.calls.sendSms[0].to, "+918123451109");
      assert.deepEqual(
        body.data.delivery.map(({ channel, status }) => ({ channel, status })),
        [
          { channel: "whatsapp", status: "queued" },
          { channel: "sms", status: "queued" },
        ],
      );
    });
  } finally {
    config.DASHBOARD_BASE_URL = previousBaseUrl;
    config.TWILIO_TEAM_INVITE_CONTENT_SID = previousContentSid;
  }
});

test("POST /api/v1/team/invites still sends SMS when WhatsApp fails", async () => {
  const { config } = require("../../src/config");
  const previousBaseUrl = config.DASHBOARD_BASE_URL;
  config.DASHBOARD_BASE_URL = "https://app.schedurx.test";

  const firebaseAdminApp = createFirebaseAdminStub({
    decodedToken: { uid: "staff-1", role: "doctor", clinicId: "clinic-1" },
  });
  const supabaseClient = createTableStub({
    Staff: [{ id: "staff-1", firebaseUid: "staff-1", clinicId: "clinic-1" }],
    Clinic: [{ id: "clinic-1", name: "Care Clinic", whatsappFrom: "+14155550100" }],
    StaffInvite: [],
  });
  const twilioClient = createTwilioStub({ shouldFailWhatsApp: true });
  const app = createApp({ supabaseClient, nettuClient: null, firebaseAdminApp, twilioClient });

  try {
    await withServer(app, async ({ request }) => {
      const response = await request("/api/v1/team/invites", {
        method: "POST",
        headers: { Authorization: "Bearer anything", "Content-Type": "application/json" },
        body: JSON.stringify({ name: "Reception Test", phone: "8123451109", role: "receptionist" }),
      });
      const body = await readJson(response);

      assert.equal(response.status, 201);
      assert.equal(twilioClient.calls.sendWhatsApp.length, 1);
      assert.equal(twilioClient.calls.sendSms.length, 1);
      assert.equal(body.data.delivery.find((item) => item.channel === "whatsapp").status, "failed");
      assert.equal(body.data.delivery.find((item) => item.channel === "sms").status, "queued");
    });
  } finally {
    config.DASHBOARD_BASE_URL = previousBaseUrl;
  }
});

test("POST /api/v1/team/invites rejects an invalid phone before creating or sending an invite", async () => {
  const firebaseAdminApp = createFirebaseAdminStub({
    decodedToken: { uid: "staff-1", role: "doctor", clinicId: "clinic-1" },
  });
  const supabaseClient = createTableStub({
    Staff: [{ id: "staff-1", firebaseUid: "staff-1", clinicId: "clinic-1" }],
    StaffInvite: [],
  });
  const twilioClient = createTwilioStub();
  const app = createApp({ supabaseClient, nettuClient: null, firebaseAdminApp, twilioClient });

  await withServer(app, async ({ request }) => {
    const response = await request("/api/v1/team/invites", {
      method: "POST",
      headers: { Authorization: "Bearer anything", "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Bad Number", phone: "12345", role: "doctor" }),
    });
    const body = await readJson(response);

    assert.equal(response.status, 422);
    assert.equal(body.error.code, "INVALID_PHONE");
    assert.equal(supabaseClient._tables.StaffInvite.length, 0);
    assert.equal(twilioClient.calls.sendWhatsApp.length, 0);
    assert.equal(twilioClient.calls.sendSms.length, 0);
  });
});

test("GET /api/v1/appointments scopes strictly to the authenticated staff member's clinicId", async () => {
  const firebaseAdminApp = createFirebaseAdminStub({
    decodedToken: { uid: "staff-1", role: "doctor", clinicId: "clinic-1" },
  });
  const supabaseClient = createTableStub({
    Staff: [{ id: "staff-1", firebaseUid: "staff-1", clinicId: "clinic-1" }],
    Appointment: [
      { id: "apt_1", clinicId: "clinic-1", doctorId: "doc-1", timeslot: "2026-08-01T10:00:00", status: "booked" },
      { id: "apt_2", clinicId: "clinic-2", doctorId: "doc-9", timeslot: "2026-08-01T11:00:00", status: "booked" },
    ],
  });
  const app = createApp({
    supabaseClient,
    nettuClient: null,
    firebaseAdminApp,
    stripeClient: null,
    openaiClient: null,
  });

  await withServer(app, async ({ request }) => {
    const response = await request("/api/v1/appointments", { headers: { Authorization: "Bearer anything" } });
    const body = await readJson(response);

    assert.equal(response.status, 200);
    assert.equal(body.data.appointments.length, 1);
    assert.equal(body.data.appointments[0].id, "apt_1");
  });
});

function makeReschedulableNettuStub() {
  return {
    async createEvent() {
      return { id: "nettu-event-new" };
    },
    async deleteEvent() {
      return { id: "nettu-event-old" };
    },
  };
}

test("PATCH /api/v1/appointments/:id reschedules a real appointment and keeps status bookable (not the literal 'rescheduled')", async () => {
  const firebaseAdminApp = createFirebaseAdminStub({
    decodedToken: { uid: "staff-1", role: "receptionist", clinicId: "clinic-1" },
  });
  const supabaseClient = createTableStub({
    Staff: [{ id: "staff-1", firebaseUid: "staff-1", clinicId: "clinic-1" }],
    Clinic: [
      {
        id: "clinic-1",
        status: "active",
        schedulerServiceId: "svc-1",
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
        settings: {},
      },
    ],
    Doctor: [
      {
        id: "doc-1",
        clinicId: "clinic-1",
        fullName: "Dr. Priya",
        isActive: true,
        schedulerDoctorId: "n-doc-1",
        schedulerCalendarId: "n-cal-1",
      },
    ],
    Appointment: [
      {
        id: "apt_1",
        clinicId: "clinic-1",
        doctorId: "doc-1",
        timeslot: new Date(Date.now() + 48 * 60 * 60 * 1000).toISOString(),
        status: "booked",
        auditHistory: [],
      },
    ],
  });
  const app = createApp({
    supabaseClient,
    nettuClient: makeReschedulableNettuStub(),
    firebaseAdminApp,
    stripeClient: null,
    openaiClient: null,
  });

  await withServer(app, async ({ request }) => {
    const newStart = new Date(Date.now() + 72 * 60 * 60 * 1000).toISOString();
    const response = await request("/api/v1/appointments/apt_1", {
      method: "PATCH",
      headers: { Authorization: "Bearer anything", "Content-Type": "application/json" },
      body: JSON.stringify({ doctorId: "doc-1", newStart }),
    });
    const body = await readJson(response);
    assert.equal(response.status, 200, JSON.stringify(body));

    const { data: row } = await supabaseClient.from("Appointment").eq("id", "apt_1").maybeSingle();
    assert.equal(row.status, "booked");
    assert.equal(row.timeslot, newStart);
  });
});

test("DELETE /api/v1/appointments/:id cancels a real appointment, scoped to the caller's clinic", async () => {
  const firebaseAdminApp = createFirebaseAdminStub({
    decodedToken: { uid: "staff-1", role: "receptionist", clinicId: "clinic-1" },
  });
  const supabaseClient = createTableStub({
    Staff: [{ id: "staff-1", firebaseUid: "staff-1", clinicId: "clinic-1" }],
    Clinic: [
      {
        id: "clinic-1",
        status: "active",
        timezone: "Asia/Kolkata",
        cancellationCutoffHours: 0,
        settings: {},
      },
    ],
    Doctor: [{ id: "doc-1", clinicId: "clinic-1", fullName: "Dr. Priya", schedulerDoctorId: "n-doc-1" }],
    Appointment: [
      {
        id: "apt_1",
        clinicId: "clinic-1",
        doctorId: "doc-1",
        timeslot: new Date(Date.now() + 48 * 60 * 60 * 1000).toISOString(),
        status: "booked",
        auditHistory: [],
      },
      {
        id: "apt_2",
        clinicId: "clinic-2",
        doctorId: "doc-9",
        timeslot: new Date(Date.now() + 48 * 60 * 60 * 1000).toISOString(),
        status: "booked",
        auditHistory: [],
      },
    ],
  });
  const app = createApp({
    supabaseClient,
    nettuClient: makeReschedulableNettuStub(),
    firebaseAdminApp,
    stripeClient: null,
    openaiClient: null,
  });

  await withServer(app, async ({ request }) => {
    // Cross-clinic appointment must not be cancellable by this staff member.
    const cross = await request("/api/v1/appointments/apt_2", {
      method: "DELETE",
      headers: { Authorization: "Bearer anything" },
    });
    assert.equal(cross.status, 404);

    const response = await request("/api/v1/appointments/apt_1", {
      method: "DELETE",
      headers: { Authorization: "Bearer anything" },
    });
    assert.equal(response.status, 200);

    const { data: row } = await supabaseClient.from("Appointment").eq("id", "apt_1").maybeSingle();
    assert.equal(row.status, "cancelled");
  });
});

// ─── /api/v1/threads ────────────────────────────────────────────────────────

test("POST /api/v1/threads/find-or-create resolves a real thread for a patient, reusing an existing open one", async () => {
  const firebaseAdminApp = createFirebaseAdminStub({
    decodedToken: { uid: "staff-1", role: "receptionist", clinicId: "clinic-1" },
  });
  const supabaseClient = createTableStub({
    Staff: [{ id: "staff-1", firebaseUid: "staff-1", clinicId: "clinic-1" }],
    Patient: [{ id: "pat_1", clinicId: "clinic-1", fullName: "Rahul", contactNumber: "+919999999999" }],
    Thread: [
      {
        id: "thread_1",
        clinicId: "clinic-1",
        patientId: "pat_1",
        channel: "whatsapp",
        contactPhone: "+919999999999",
        status: "open",
        unreadCount: 0,
      },
    ],
  });
  const app = createApp({
    supabaseClient,
    nettuClient: null,
    firebaseAdminApp,
    stripeClient: null,
    openaiClient: null,
  });

  await withServer(app, async ({ request }) => {
    const response = await request("/api/v1/threads/find-or-create", {
      method: "POST",
      headers: { Authorization: "Bearer anything", "Content-Type": "application/json" },
      body: JSON.stringify({ patientId: "pat_1" }),
    });
    const body = await readJson(response);
    assert.equal(response.status, 200, JSON.stringify(body));
    assert.equal(body.data.thread.id, "thread_1");
  });
});

test("POST /api/v1/threads/find-or-create rejects a patient with no phone on file", async () => {
  const firebaseAdminApp = createFirebaseAdminStub({
    decodedToken: { uid: "staff-1", role: "receptionist", clinicId: "clinic-1" },
  });
  const supabaseClient = createTableStub({
    Staff: [{ id: "staff-1", firebaseUid: "staff-1", clinicId: "clinic-1" }],
    Patient: [{ id: "pat_1", clinicId: "clinic-1", fullName: "Rahul", contactNumber: null }],
  });
  const app = createApp({
    supabaseClient,
    nettuClient: null,
    firebaseAdminApp,
    stripeClient: null,
    openaiClient: null,
  });

  await withServer(app, async ({ request }) => {
    const response = await request("/api/v1/threads/find-or-create", {
      method: "POST",
      headers: { Authorization: "Bearer anything", "Content-Type": "application/json" },
      body: JSON.stringify({ patientId: "pat_1" }),
    });
    assert.equal(response.status, 422);
  });
});

test("POST /api/v1/threads/:id/messages sends through the real Twilio client when one is configured", async () => {
  const firebaseAdminApp = createFirebaseAdminStub({
    decodedToken: { uid: "staff-1", role: "doctor", clinicId: "clinic-1" },
  });
  const supabaseClient = createTableStub({
    Staff: [{ id: "staff-1", firebaseUid: "staff-1", clinicId: "clinic-1" }],
    Clinic: [{ id: "clinic-1", whatsappFrom: "+15550001111", settings: {} }],
    Thread: [
      {
        id: "thread_1",
        clinicId: "clinic-1",
        patientId: "pat_1",
        channel: "whatsapp",
        contactPhone: "+919999999999",
        status: "open",
        unreadCount: 0,
      },
    ],
  });
  const twilioClient = createTwilioStub();
  const app = createApp({
    supabaseClient,
    nettuClient: null,
    firebaseAdminApp,
    stripeClient: null,
    openaiClient: null,
    twilioClient,
  });

  await withServer(app, async ({ request }) => {
    const response = await request("/api/v1/threads/thread_1/messages", {
      method: "POST",
      headers: { Authorization: "Bearer anything", "Content-Type": "application/json" },
      body: JSON.stringify({ body: "Your results are ready." }),
    });
    const body = await readJson(response);
    assert.equal(response.status, 201, JSON.stringify(body));
    assert.equal(body.data.message.status, "sent");
    assert.equal(twilioClient.calls.sendWhatsApp.length, 1);
    assert.equal(twilioClient.calls.sendWhatsApp[0].to, "+919999999999");
    assert.equal(twilioClient.calls.sendWhatsApp[0].body, "Your results are ready.");
  });
});

// ─── /api/v1/doctors ────────────────────────────────────────────────────────

test("PATCH /api/v1/doctors/:id lets a doctor edit their own fee/slot/hours but not another doctor's", async () => {
  const supabaseClient = createTableStub({
    Staff: [
      { id: "staff-1", firebaseUid: "staff-1", clinicId: "clinic-1" },
      { id: "staff-2", firebaseUid: "staff-2", clinicId: "clinic-1" },
    ],
    Doctor: [
      {
        id: "doc-1",
        clinicId: "clinic-1",
        fullName: "Dr. Priya",
        feeInr: 500,
        slotDurationOverrideMins: 15,
        isActive: true,
      },
      { id: "doc-2", clinicId: "clinic-1", fullName: "Dr. Rahul", feeInr: 400, isActive: true },
    ],
  });

  const asDoc1 = createFirebaseAdminStub({
    decodedToken: { uid: "staff-1", role: "doctor", clinicId: "clinic-1", doctorId: "doc-1" },
  });
  const app1 = createApp({
    supabaseClient,
    nettuClient: null,
    firebaseAdminApp: asDoc1,
    stripeClient: null,
    openaiClient: null,
  });

  await withServer(app1, async ({ request }) => {
    const ownUpdate = await request("/api/v1/doctors/doc-1", {
      method: "PATCH",
      headers: { Authorization: "Bearer anything", "Content-Type": "application/json" },
      body: JSON.stringify({ feeInr: 700, slotDurationOverrideMins: 20 }),
    });
    const ownBody = await readJson(ownUpdate);
    assert.equal(ownUpdate.status, 200);
    assert.equal(ownBody.data.doctor.feeInr, 700);
    assert.equal(ownBody.data.doctor.slotDurationOverrideMins, 20);

    const otherUpdate = await request("/api/v1/doctors/doc-2", {
      method: "PATCH",
      headers: { Authorization: "Bearer anything", "Content-Type": "application/json" },
      body: JSON.stringify({ feeInr: 999 }),
    });
    assert.equal(otherUpdate.status, 403);
  });

  const asOwner = createFirebaseAdminStub({
    decodedToken: { uid: "staff-2", role: "owner", clinicId: "clinic-1", doctorId: null },
  });
  const app2 = createApp({
    supabaseClient,
    nettuClient: null,
    firebaseAdminApp: asOwner,
    stripeClient: null,
    openaiClient: null,
  });

  await withServer(app2, async ({ request }) => {
    const ownerUpdate = await request("/api/v1/doctors/doc-2", {
      method: "PATCH",
      headers: { Authorization: "Bearer anything", "Content-Type": "application/json" },
      body: JSON.stringify({ feeInr: 999 }),
    });
    const body = await readJson(ownerUpdate);
    assert.equal(ownerUpdate.status, 200);
    assert.equal(body.data.doctor.feeInr, 999);
  });
});

// ─── /api/v1/notifications ──────────────────────────────────────────────────

test("PATCH /api/v1/notifications/:id/read marks a single notification read, scoped to the caller", async () => {
  const supabaseClient = createTableStub({
    Staff: [
      { id: "staff-1", firebaseUid: "staff-1", clinicId: "clinic-1" },
      { id: "staff-2", firebaseUid: "staff-2", clinicId: "clinic-1" },
    ],
    Notification: [
      { id: "notif-mine", clinicId: "clinic-1", staffId: "staff-1", type: "reminder", readAt: null },
      { id: "notif-broadcast", clinicId: "clinic-1", staffId: null, type: "reminder", readAt: null },
      { id: "notif-other-staff", clinicId: "clinic-1", staffId: "staff-2", type: "reminder", readAt: null },
      { id: "notif-other-clinic", clinicId: "clinic-2", staffId: null, type: "reminder", readAt: null },
    ],
  });
  const firebaseAdminApp = createFirebaseAdminStub({
    decodedToken: { uid: "staff-1", role: "doctor", clinicId: "clinic-1" },
  });
  const app = createApp({
    supabaseClient,
    nettuClient: null,
    firebaseAdminApp,
    stripeClient: null,
    openaiClient: null,
  });

  await withServer(app, async ({ request }) => {
    const own = await request("/api/v1/notifications/notif-mine/read", {
      method: "PATCH",
      headers: { Authorization: "Bearer anything" },
    });
    const ownBody = await readJson(own);
    assert.equal(own.status, 200);
    assert.ok(ownBody.data.notification.readAt);

    const broadcast = await request("/api/v1/notifications/notif-broadcast/read", {
      method: "PATCH",
      headers: { Authorization: "Bearer anything" },
    });
    assert.equal(broadcast.status, 200);

    const otherStaff = await request("/api/v1/notifications/notif-other-staff/read", {
      method: "PATCH",
      headers: { Authorization: "Bearer anything" },
    });
    assert.equal(otherStaff.status, 404);

    const otherClinic = await request("/api/v1/notifications/notif-other-clinic/read", {
      method: "PATCH",
      headers: { Authorization: "Bearer anything" },
    });
    assert.equal(otherClinic.status, 404);

    // Neither out-of-scope notification was mutated.
    assert.equal(supabaseClient._tables.Notification.find((n) => n.id === "notif-other-staff").readAt, null);
    assert.equal(supabaseClient._tables.Notification.find((n) => n.id === "notif-other-clinic").readAt, null);
  });
});

test("DELETE /api/v1/notifications/:id removes a notification, scoped the same way as read", async () => {
  const supabaseClient = createTableStub({
    Staff: [{ id: "staff-1", firebaseUid: "staff-1", clinicId: "clinic-1" }],
    Notification: [
      { id: "notif-mine", clinicId: "clinic-1", staffId: "staff-1", type: "reminder", readAt: null },
      { id: "notif-other-clinic", clinicId: "clinic-2", staffId: null, type: "reminder", readAt: null },
    ],
  });
  const firebaseAdminApp = createFirebaseAdminStub({
    decodedToken: { uid: "staff-1", role: "doctor", clinicId: "clinic-1" },
  });
  const app = createApp({
    supabaseClient,
    nettuClient: null,
    firebaseAdminApp,
    stripeClient: null,
    openaiClient: null,
  });

  await withServer(app, async ({ request }) => {
    const response = await request("/api/v1/notifications/notif-mine", {
      method: "DELETE",
      headers: { Authorization: "Bearer anything" },
    });
    assert.equal(response.status, 204);
    assert.equal(
      supabaseClient._tables.Notification.some((n) => n.id === "notif-mine"),
      false,
    );

    // Deleting a notification outside the caller's clinic is a silent no-op
    // (same idempotent-delete behavior as DELETE /api/v1/tasks/:id), not a 404.
    const foreignAttempt = await request("/api/v1/notifications/notif-other-clinic", {
      method: "DELETE",
      headers: { Authorization: "Bearer anything" },
    });
    assert.equal(foreignAttempt.status, 204);
    assert.equal(
      supabaseClient._tables.Notification.some((n) => n.id === "notif-other-clinic"),
      true,
    );
  });
});

// ─── /api/v1/assistant ──────────────────────────────────────────────────────

// Two-step mock: first call returns a tool-call for the given tool/input,
// second call (after the tool result is fed back) returns a plain-text reply
// — mirrors how streamText's stopWhen: stepCountIs(N) drives a real model.
function makeMockAssistantModel({ toolName, toolInput, replyText }) {
  let callCount = 0;
  return new MockLanguageModelV4({
    doStream: async () => {
      callCount += 1;
      if (callCount === 1) {
        return {
          stream: simulateReadableStream({
            chunks: [
              { type: "stream-start", warnings: [] },
              { type: "tool-call", toolCallId: "call-1", toolName, input: JSON.stringify(toolInput) },
              {
                type: "finish",
                finishReason: "tool-calls",
                usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
              },
            ],
          }),
        };
      }
      return {
        stream: simulateReadableStream({
          chunks: [
            { type: "stream-start", warnings: [] },
            { type: "text-start", id: "t1" },
            { type: "text-delta", id: "t1", delta: replyText },
            { type: "text-end", id: "t1" },
            { type: "finish", finishReason: "stop", usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } },
          ],
        }),
      };
    },
  });
}

test("POST /api/v1/assistant requires auth", async () => {
  const firebaseAdminApp = createFirebaseAdminStub({
    decodedToken: { uid: "staff-1", role: "doctor", clinicId: "clinic-1" },
  });
  const app = createApp({
    supabaseClient: createTableStub({ Staff: [{ id: "staff-1", firebaseUid: "staff-1", clinicId: "clinic-1" }] }),
    nettuClient: null,
    firebaseAdminApp,
    stripeClient: null,
    openaiClient: null,
    assistantModel: makeMockAssistantModel({ toolName: "add_task", toolInput: {}, replyText: "unused" }),
  });

  await withServer(app, async ({ request }) => {
    const response = await request("/api/v1/assistant", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ messages: [] }),
    });
    assert.equal(response.status, 401);
  });
});

test("POST /api/v1/assistant runs the add_task tool end-to-end and streams a reply", async () => {
  const firebaseAdminApp = createFirebaseAdminStub({
    decodedToken: { uid: "staff-1", role: "doctor", clinicId: "clinic-1", doctorId: "doc-1" },
  });
  const supabaseClient = createTableStub({
    Staff: [{ id: "staff-1", firebaseUid: "staff-1", clinicId: "clinic-1" }],
    Doctor: [{ id: "doc-1", clinicId: "clinic-1", fullName: "Dr. Priya", isActive: true }],
  });
  const app = createApp({
    supabaseClient,
    nettuClient: null,
    firebaseAdminApp,
    stripeClient: null,
    openaiClient: null,
    assistantModel: makeMockAssistantModel({
      toolName: "add_task",
      toolInput: { title: "Call the lab about an echo" },
      replyText: "Added it to your tasks.",
    }),
  });

  await withServer(app, async ({ request }) => {
    const response = await request("/api/v1/assistant", {
      method: "POST",
      headers: { Authorization: "Bearer anything", "Content-Type": "application/json" },
      body: JSON.stringify({
        messages: [
          { id: "1", role: "user", parts: [{ type: "text", text: "remind me to call the lab about an echo" }] },
        ],
      }),
    });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("content-type"), "text/event-stream");

    const body = await response.text();
    assert.match(body, /"toolName":"add_task"/);
    // smoothStream re-chunks the reply into per-word SSE deltas, so the full
    // sentence never appears as one contiguous substring — reassemble it the
    // same way useChat does client-side before asserting on it.
    const replyText = [...body.matchAll(/"type":"text-delta","id":"t1","delta":"([^"]*)"/g)].map((m) => m[1]).join("");
    assert.equal(replyText, "Added it to your tasks.");

    const task = supabaseClient._tables.Task[0];
    assert.equal(task.clinicId, "clinic-1");
    assert.equal(task.createdByStaffId, "staff-1");
    assert.equal(task.title, "Call the lab about an echo");
    assert.equal(task.viaAI, true);
  });
});

test("POST /api/v1/assistant/speak synthesizes speech via ElevenLabs when configured", async () => {
  const firebaseAdminApp = createFirebaseAdminStub({
    decodedToken: { uid: "staff-1", role: "doctor", clinicId: "clinic-1", doctorId: "doc-1" },
  });
  const supabaseClient = createTableStub({ Staff: [{ id: "staff-1", firebaseUid: "staff-1", clinicId: "clinic-1" }] });
  const elevenLabsClient = { synthesizeSpeech: async ({ text }) => Buffer.from(`audio-for:${text}`) };
  const app = createApp({
    supabaseClient,
    nettuClient: null,
    firebaseAdminApp,
    stripeClient: null,
    openaiClient: null,
    assistantModel: makeMockAssistantModel({ toolName: "add_task", toolInput: {}, replyText: "unused" }),
    elevenLabsClient,
  });

  await withServer(app, async ({ request }) => {
    const response = await request("/api/v1/assistant/speak", {
      method: "POST",
      headers: { Authorization: "Bearer anything", "Content-Type": "application/json" },
      body: JSON.stringify({ text: "You're all set for tomorrow at 3pm." }),
    });
    const body = await readJson(response);
    assert.equal(response.status, 200, JSON.stringify(body));
    assert.equal(
      Buffer.from(body.data.audioBase64, "base64").toString(),
      "audio-for:You're all set for tomorrow at 3pm.",
    );
  });
});

test("POST /api/v1/assistant/speak is unavailable without an ElevenLabs client", async () => {
  const firebaseAdminApp = createFirebaseAdminStub({
    decodedToken: { uid: "staff-1", role: "doctor", clinicId: "clinic-1", doctorId: "doc-1" },
  });
  const app = createApp({
    supabaseClient: createTableStub({ Staff: [{ id: "staff-1", firebaseUid: "staff-1", clinicId: "clinic-1" }] }),
    nettuClient: null,
    firebaseAdminApp,
    stripeClient: null,
    openaiClient: null,
    assistantModel: makeMockAssistantModel({ toolName: "add_task", toolInput: {}, replyText: "unused" }),
  });

  await withServer(app, async ({ request }) => {
    const response = await request("/api/v1/assistant/speak", {
      method: "POST",
      headers: { Authorization: "Bearer anything", "Content-Type": "application/json" },
      body: JSON.stringify({ text: "hello" }),
    });
    assert.equal(response.status, 503);
  });
});

// ─── /api/v1/call-logs, /api/v1/wa-logs, /tools/call-logs ──────────────────────

test("GET /api/v1/call-logs scopes strictly to the authenticated staff member's clinicId", async () => {
  const firebaseAdminApp = createFirebaseAdminStub({
    decodedToken: { uid: "staff-1", role: "doctor", clinicId: "clinic-1" },
  });
  const supabaseClient = createTableStub({
    Staff: [{ id: "staff-1", firebaseUid: "staff-1", clinicId: "clinic-1" }],
    CallLog: [
      {
        id: "call_1",
        clinicId: "clinic-1",
        phone: "+919999999999",
        name: "Priya",
        lang: "Hindi",
        durationSec: 90,
        outcome: "booked",
        summary: "Booked a slot",
        createdAt: "2026-08-01T10:00:00Z",
      },
      {
        id: "call_2",
        clinicId: "clinic-2",
        phone: "+918888888888",
        name: "Other clinic",
        lang: "English",
        durationSec: 30,
        outcome: "info",
        summary: null,
        createdAt: "2026-08-01T09:00:00Z",
      },
    ],
  });
  const app = createApp({
    supabaseClient,
    nettuClient: null,
    firebaseAdminApp,
    stripeClient: null,
    openaiClient: null,
  });

  await withServer(app, async ({ request }) => {
    const response = await request("/api/v1/call-logs", { headers: { Authorization: "Bearer anything" } });
    const body = await readJson(response);

    assert.equal(response.status, 200);
    assert.equal(body.data.callLogs.length, 1);
    assert.equal(body.data.callLogs[0].id, "call_1");
  });
});

test("GET /api/v1/wa-logs scopes strictly to the authenticated staff member's clinicId", async () => {
  const firebaseAdminApp = createFirebaseAdminStub({
    decodedToken: { uid: "staff-1", role: "doctor", clinicId: "clinic-1" },
  });
  const supabaseClient = createTableStub({
    Staff: [{ id: "staff-1", firebaseUid: "staff-1", clinicId: "clinic-1" }],
    WaLog: [
      {
        id: "wa_1",
        clinicId: "clinic-1",
        direction: "outbound",
        payload: { body: "hi" },
        createdAt: "2026-08-01T10:00:00Z",
      },
      { id: "wa_2", clinicId: "clinic-2", direction: "inbound", payload: {}, createdAt: "2026-08-01T09:00:00Z" },
    ],
  });
  const app = createApp({
    supabaseClient,
    nettuClient: null,
    firebaseAdminApp,
    stripeClient: null,
    openaiClient: null,
  });

  await withServer(app, async ({ request }) => {
    const response = await request("/api/v1/wa-logs", { headers: { Authorization: "Bearer anything" } });
    const body = await readJson(response);

    assert.equal(response.status, 200);
    assert.equal(body.data.waLogs.length, 1);
    assert.equal(body.data.waLogs[0].id, "wa_1");
  });
});

test("POST /tools/call-logs requires bearer auth and creates a real row", async () => {
  const supabaseClient = createTableStub();
  const app = createApp({ supabaseClient, nettuClient: null });

  await withServer(app, async ({ request }) => {
    const noAuth = await request("/tools/call-logs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ clinicId: "clinic-1", phone: "+919999999999" }),
    });
    assert.equal(noAuth.status, 401);

    const missingFields = await request("/tools/call-logs", {
      method: "POST",
      headers: { Authorization: `Bearer ${process.env.TOOLS_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ clinicId: "clinic-1" }),
    });
    assert.equal(missingFields.status, 422);

    const created = await request("/tools/call-logs", {
      method: "POST",
      headers: { Authorization: `Bearer ${process.env.TOOLS_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ clinicId: "clinic-1", phone: "+919999999999", name: "Priya", outcome: "booked" }),
    });
    const body = await readJson(created);
    assert.equal(created.status, 201);
    assert.equal(body.clinicId, "clinic-1");
    assert.equal(body.phone, "+919999999999");
    assert.equal(supabaseClient._tables.CallLog.length, 1);
  });
});

// ─── /api/v1/analytics/utilization, /practice-pulse ────────────────────────────

test("GET /api/v1/analytics/utilization computes possible vs booked slots per doctor", async () => {
  const firebaseAdminApp = createFirebaseAdminStub({
    decodedToken: { uid: "staff-1", role: "doctor", clinicId: "clinic-1" },
  });
  const today = new Date().toISOString().slice(0, 10);
  const supabaseClient = createTableStub({
    Staff: [{ id: "staff-1", firebaseUid: "staff-1", clinicId: "clinic-1" }],
    Clinic: [
      {
        id: "clinic-1",
        workingDays: ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"],
        openingHour: 9,
        closingHour: 18,
        defaultAppointmentDurationMins: 30,
      },
    ],
    Doctor: [
      {
        id: "doc-1",
        fullName: "Dr. Priya",
        clinicId: "clinic-1",
        isActive: true,
        workingDaysOverride: null,
        workingHoursStart: null,
        workingHoursEnd: null,
        slotDurationOverrideMins: null,
      },
    ],
    Appointment: [
      { id: "apt_1", clinicId: "clinic-1", doctorId: "doc-1", timeslot: `${today}T10:00:00`, status: "booked" },
      { id: "apt_2", clinicId: "clinic-1", doctorId: "doc-1", timeslot: `${today}T11:00:00`, status: "blocked" },
      { id: "apt_3", clinicId: "clinic-1", doctorId: "doc-1", timeslot: `${today}T12:00:00`, status: "cancelled" },
      { id: "apt_4", clinicId: "clinic-1", doctorId: "doc-2", timeslot: `${today}T12:00:00`, status: "booked" },
    ],
  });
  const app = createApp({
    supabaseClient,
    nettuClient: null,
    firebaseAdminApp,
    stripeClient: null,
    openaiClient: null,
  });

  await withServer(app, async ({ request }) => {
    const response = await request("/api/v1/analytics/utilization?days=1", {
      headers: { Authorization: "Bearer anything" },
    });
    const body = await readJson(response);

    assert.equal(response.status, 200);
    assert.equal(body.data.doctors.length, 1);
    assert.equal(body.data.doctors[0].doctorId, "doc-1");
    assert.equal(body.data.doctors[0].totalPossibleSlots, 18); // 540 working minutes / 30 min slots
    assert.equal(body.data.doctors[0].bookedSlots, 2); // booked + blocked, cancelled excluded, doc-2 excluded
  });
});

test("GET /api/v1/analytics/practice-pulse is unavailable without an OpenAI client", async () => {
  const firebaseAdminApp = createFirebaseAdminStub({
    decodedToken: { uid: "staff-1", role: "doctor", clinicId: "clinic-1" },
  });
  const app = createApp({
    supabaseClient: createTableStub({ Staff: [{ id: "staff-1", firebaseUid: "staff-1", clinicId: "clinic-1" }] }),
    nettuClient: null,
    firebaseAdminApp,
    stripeClient: null,
    openaiClient: null,
  });

  await withServer(app, async ({ request }) => {
    const response = await request("/api/v1/analytics/practice-pulse", {
      headers: { Authorization: "Bearer anything" },
    });
    const body = await readJson(response);

    assert.equal(response.status, 503);
    assert.equal(body.error.code, "AI_NOT_CONFIGURED");
  });
});

test("GET /api/v1/analytics/practice-pulse returns real insights when configured", async () => {
  const firebaseAdminApp = createFirebaseAdminStub({
    decodedToken: { uid: "staff-1", role: "doctor", clinicId: "clinic-1" },
  });
  const openaiClient = createOpenaiStub({
    content: JSON.stringify({
      insights: [
        "Cancellations rose 10% this week.",
        "Dr. Priya is fully booked Fridays.",
        "Revenue is up 5% vs last period.",
      ],
    }),
  });
  const app = createApp({
    supabaseClient: createTableStub({ Staff: [{ id: "staff-1", firebaseUid: "staff-1", clinicId: "clinic-1" }] }),
    nettuClient: null,
    firebaseAdminApp,
    stripeClient: null,
    openaiClient,
  });

  await withServer(app, async ({ request }) => {
    const response = await request("/api/v1/analytics/practice-pulse", {
      headers: { Authorization: "Bearer anything" },
    });
    const body = await readJson(response);

    assert.equal(response.status, 200);
    assert.equal(body.data.insights.length, 3);
  });
});

// ─── /api/v1/visits/:id/upload-url, /attachments ────────────────────────────────

test("POST /api/v1/visits/:id/upload-url returns a signed upload URL scoped to clinic/visit", async () => {
  const firebaseAdminApp = createFirebaseAdminStub({
    decodedToken: { uid: "staff-1", role: "doctor", clinicId: "clinic-1" },
  });
  const supabaseClient = createTableStub({ Staff: [{ id: "staff-1", firebaseUid: "staff-1", clinicId: "clinic-1" }] });
  const app = createApp({
    supabaseClient,
    nettuClient: null,
    firebaseAdminApp,
    stripeClient: null,
    openaiClient: null,
  });

  await withServer(app, async ({ request }) => {
    const response = await request("/api/v1/visits/visit_1/upload-url", {
      method: "POST",
      headers: { Authorization: "Bearer anything", "Content-Type": "application/json" },
      body: JSON.stringify({ fileName: "rx.pdf", contentType: "application/pdf" }),
    });
    const body = await readJson(response);

    assert.equal(response.status, 200);
    assert.match(body.data.path, /^clinic-1\/visit_1\//);
    assert.ok(body.data.uploadUrl.includes(body.data.path));
  });
});

test("POST /api/v1/visits/:id/attachments appends to rxAttachments and read-url rejects a foreign path", async () => {
  const firebaseAdminApp = createFirebaseAdminStub({
    decodedToken: { uid: "staff-1", role: "doctor", clinicId: "clinic-1" },
  });
  const supabaseClient = createTableStub({
    Staff: [{ id: "staff-1", firebaseUid: "staff-1", clinicId: "clinic-1" }],
    Visit: [{ id: "visit_1", clinicId: "clinic-1", patientId: "pat_1", rxAttachments: [] }],
  });
  const app = createApp({
    supabaseClient,
    nettuClient: null,
    firebaseAdminApp,
    stripeClient: null,
    openaiClient: null,
  });

  await withServer(app, async ({ request }) => {
    const created = await request("/api/v1/visits/visit_1/attachments", {
      method: "POST",
      headers: { Authorization: "Bearer anything", "Content-Type": "application/json" },
      body: JSON.stringify({ path: "clinic-1/visit_1/rx.pdf", type: "digital" }),
    });
    const body = await readJson(created);
    assert.equal(created.status, 201);
    assert.equal(body.data.visit.rxAttachments.length, 1);
    assert.equal(body.data.visit.rxAttachments[0].type, "digital");

    const goodRead = await request(
      `/api/v1/visits/visit_1/attachments/read-url?path=${encodeURIComponent("clinic-1/visit_1/rx.pdf")}`,
      {
        headers: { Authorization: "Bearer anything" },
      },
    );
    assert.equal(goodRead.status, 200);

    const badRead = await request(
      `/api/v1/visits/visit_1/attachments/read-url?path=${encodeURIComponent("clinic-2/visit_9/rx.pdf")}`,
      {
        headers: { Authorization: "Bearer anything" },
      },
    );
    assert.equal(badRead.status, 403);
  });
});

test("POST /api/v1/visits/:id/recap turns a typed recap into a structured note and saves it", async () => {
  const firebaseAdminApp = createFirebaseAdminStub({
    decodedToken: { uid: "staff-1", role: "doctor", clinicId: "clinic-1" },
  });
  const supabaseClient = createTableStub({
    Staff: [{ id: "staff-1", firebaseUid: "staff-1", clinicId: "clinic-1" }],
    Visit: [{ id: "visit_1", clinicId: "clinic-1", patientId: "pat_1", notes: null }],
  });
  const openaiClient = createOpenaiStub({
    content: JSON.stringify({ note: "Patient presented with mild fever; advised rest and paracetamol." }),
  });
  const app = createApp({ supabaseClient, nettuClient: null, firebaseAdminApp, stripeClient: null, openaiClient });

  await withServer(app, async ({ request }) => {
    const response = await request("/api/v1/visits/visit_1/recap", {
      method: "POST",
      headers: { Authorization: "Bearer anything", "Content-Type": "application/json" },
      body: JSON.stringify({ text: "mild fever, told them to rest and take paracetamol" }),
    });
    const body = await readJson(response);
    assert.equal(response.status, 200, JSON.stringify(body));
    assert.equal(body.data.visit.notes, "Patient presented with mild fever; advised rest and paracetamol.");
  });
});

test("POST /api/v1/visits/:id/recap is unavailable without an OpenAI client", async () => {
  const firebaseAdminApp = createFirebaseAdminStub({
    decodedToken: { uid: "staff-1", role: "doctor", clinicId: "clinic-1" },
  });
  const supabaseClient = createTableStub({
    Staff: [{ id: "staff-1", firebaseUid: "staff-1", clinicId: "clinic-1" }],
    Visit: [{ id: "visit_1", clinicId: "clinic-1", patientId: "pat_1" }],
  });
  const app = createApp({
    supabaseClient,
    nettuClient: null,
    firebaseAdminApp,
    stripeClient: null,
    openaiClient: null,
  });

  await withServer(app, async ({ request }) => {
    const response = await request("/api/v1/visits/visit_1/recap", {
      method: "POST",
      headers: { Authorization: "Bearer anything", "Content-Type": "application/json" },
      body: JSON.stringify({ text: "fever" }),
    });
    assert.equal(response.status, 503);
  });
});

test("POST /api/v1/media/transcribe returns a transcript and never persists anything", async () => {
  const firebaseAdminApp = createFirebaseAdminStub({
    decodedToken: { uid: "staff-1", role: "doctor", clinicId: "clinic-1" },
  });
  const supabaseClient = createTableStub({ Staff: [{ id: "staff-1", firebaseUid: "staff-1", clinicId: "clinic-1" }] });
  const openaiClient = createOpenaiStub({ transcript: "Can you move my next appointment to Friday?" });
  const app = createApp({ supabaseClient, nettuClient: null, firebaseAdminApp, stripeClient: null, openaiClient });

  await withServer(app, async ({ request }) => {
    const response = await request("/api/v1/media/transcribe", {
      method: "POST",
      headers: { Authorization: "Bearer anything", "Content-Type": "application/json" },
      body: JSON.stringify({ audioBase64: Buffer.from("fake-audio").toString("base64"), filename: "clip.webm" }),
    });
    const body = await readJson(response);
    assert.equal(response.status, 200, JSON.stringify(body));
    assert.equal(body.data.text, "Can you move my next appointment to Friday?");
  });
});

// ─── /internal/clinic ────────────────────────────────────────────────────────

// Minimal nettu-scheduler stub covering just the calendar-service call sequence
// getOrCreateClinicService/getOrCreateDoctorCalendar exercise: create-then-fetch
// for service/user/calendar/schedule, plus the two "add doctor to service" calls.
function createNettuStub() {
  let serviceN = 0;
  let userN = 0;
  let calN = 0;
  let schedN = 0;
  const services = new Map();

  return {
    async createService() {
      const service = { id: `nettu-svc-${++serviceN}`, users: [] };
      services.set(service.id, service);
      return service;
    },
    async getService(id) {
      return services.get(id) ?? null;
    },
    async createUser() {
      return { id: `nettu-user-${++userN}` };
    },
    async getUser() {
      return null;
    },
    async createCalendar() {
      return { id: `nettu-cal-${++calN}` };
    },
    async getCalendar() {
      return null;
    },
    async createSchedule() {
      return { id: `nettu-sched-${++schedN}` };
    },
    async getSchedule() {
      return null;
    },
    async addUserToService(serviceId, { userId, scheduleId }) {
      const service = services.get(serviceId);
      if (service) service.users.push({ userId, availability: { id: scheduleId } });
      return service;
    },
    async addBusyCalendar() {
      return {};
    },
  };
}

test("POST /internal/clinic creates a Clinic, Doctor, owner Staff, and sets Firebase claims", async () => {
  const firebaseAdminApp = createFirebaseAdminStub({ decodedToken: { uid: "owner-1" } });
  const supabaseClient = createTableStub();
  const app = createApp({
    supabaseClient,
    nettuClient: createNettuStub(),
    firebaseAdminApp,
    stripeClient: null,
    openaiClient: null,
  });

  await withServer(app, async ({ request }) => {
    const noAuth = await request("/internal/clinic", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ firebaseUid: "owner-1", clinicName: "Test Clinic" }),
    });
    assert.equal(noAuth.status, 401);

    const missingFields = await request("/internal/clinic", {
      method: "POST",
      headers: { Authorization: `Bearer ${process.env.INTERNAL_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ firebaseUid: "owner-1" }),
    });
    assert.equal(missingFields.status, 422);

    const created = await request("/internal/clinic", {
      method: "POST",
      headers: { Authorization: `Bearer ${process.env.INTERNAL_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        firebaseUid: "owner-1",
        email: "owner@example.com",
        fullName: "Dr. Owner",
        clinicName: "Test Clinic",
        doctor: { fullName: "Dr. Owner", specialty: "General Physician", feeInr: 500 },
      }),
    });
    const body = await readJson(created);

    assert.equal(created.status, 200);
    assert.equal(body.data.clinic.name, "Test Clinic");
    assert.equal(body.data.clinic.status, "active");
    assert.equal(body.data.doctor.clinicId, body.data.clinic.id);
    assert.equal(body.data.doctor.fullName, "Dr. Owner");
    assert.equal(body.data.staff.role, "owner");
    assert.equal(body.data.staff.doctorId, body.data.doctor.id);
    assert.equal(supabaseClient._tables.Clinic.length, 1);
    assert.equal(supabaseClient._tables.Doctor.length, 1);
    assert.equal(supabaseClient._tables.Staff.length, 1);
  });
});

// ─── /webhooks/nettu-reminders ──────────────────────────────────────────────

test("POST /webhooks/nettu-reminders rejects a bad key and creates a Notification for a valid reminder batch", async () => {
  const supabaseClient = createTableStub({
    Doctor: [{ id: "doc-1", fullName: "Dr. Priya" }],
    Appointment: [{ id: "apt_1", patientId: "pat_1", symptoms: "Fever" }],
    Patient: [{ id: "pat_1", fullName: "Test Patient" }],
  });
  // createApp only mounts /webhooks/nettu-reminders when NETTU_WEBHOOK_KEY is
  // set — set directly on config for this test since app.js reads it from
  // there, not from a constructor param.
  const { config } = require("../../src/config");
  config.NETTU_WEBHOOK_KEY = "test-nettu-webhook-key";
  const appWithWebhook = createApp({
    supabaseClient,
    nettuClient: null,
    firebaseAdminApp: null,
    stripeClient: null,
    openaiClient: null,
  });

  await withServer(appWithWebhook, async ({ request }) => {
    const badKey = await request("/webhooks/nettu-reminders", {
      method: "POST",
      headers: { "Content-Type": "application/json", "nettu-scheduler-webhook-key": "wrong" },
      body: JSON.stringify({ reminders: [] }),
    });
    assert.equal(badKey.status, 401);

    const goodKey = await request("/webhooks/nettu-reminders", {
      method: "POST",
      headers: { "Content-Type": "application/json", "nettu-scheduler-webhook-key": "test-nettu-webhook-key" },
      body: JSON.stringify({
        reminders: [
          {
            identifier: "apt_1",
            event: {
              metadata: { clinicId: "clinic-1", appointmentId: "apt_1", doctorId: "doc-1", kind: "appointment" },
            },
          },
        ],
      }),
    });
    const body = await readJson(goodKey);
    assert.equal(goodKey.status, 200);
    assert.deepEqual(body, { received: true });
    assert.equal(supabaseClient._tables.Notification.length, 1);
    assert.equal(supabaseClient._tables.Notification[0].type, "reminder");
    assert.match(supabaseClient._tables.Notification[0].body, /Dr\. Priya/);
    assert.match(supabaseClient._tables.Notification[0].body, /Test Patient/);
  });
});

test("POST /webhooks/nettu-reminders scopes a task reminder to the assigned staff member, not a broadcast", async () => {
  const supabaseClient = createTableStub({
    Task: [{ id: "task_1", clinicId: "clinic-1", assignedStaffId: "staff-1", title: "Visit bank" }],
  });
  const { config } = require("../../src/config");
  config.NETTU_WEBHOOK_KEY = "test-nettu-webhook-key";
  const appWithWebhook = createApp({
    supabaseClient,
    nettuClient: null,
    firebaseAdminApp: null,
    stripeClient: null,
    openaiClient: null,
  });

  await withServer(appWithWebhook, async ({ request }) => {
    const response = await request("/webhooks/nettu-reminders", {
      method: "POST",
      headers: { "Content-Type": "application/json", "nettu-scheduler-webhook-key": "test-nettu-webhook-key" },
      body: JSON.stringify({
        reminders: [
          {
            identifier: "task_1",
            event: {
              metadata: { clinicId: "clinic-1", taskId: "task_1", staffId: "staff-1", kind: "task" },
            },
          },
        ],
      }),
    });
    assert.equal(response.status, 200);
    assert.equal(supabaseClient._tables.Notification.length, 1);
    const notif = supabaseClient._tables.Notification[0];
    assert.equal(notif.type, "reminder");
    assert.equal(notif.staffId, "staff-1"); // personal, not a clinic-wide broadcast (staffId: null)
    assert.equal(notif.title, "Task due");
    assert.equal(notif.body, "Visit bank");
  });
});

// ─── /webhooks/twilio ────────────────────────────────────────────────────────

function formBody(fields) {
  return new URLSearchParams(fields).toString();
}

test("POST /webhooks/twilio/voice rejects a bad signature", async () => {
  const supabaseClient = createTableStub();
  const twilioClient = createTwilioStub({ shouldRejectSignature: true });
  const app = createApp({
    supabaseClient,
    nettuClient: null,
    firebaseAdminApp: null,
    stripeClient: null,
    openaiClient: null,
    twilioClient,
  });

  await withServer(app, async ({ request }) => {
    const response = await request("/webhooks/twilio/voice", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", "x-twilio-signature": "bad" },
      body: formBody({ CallSid: "CA1", From: "+919999999999", To: "+15551234567" }),
    });
    assert.equal(response.status, 401);
    assert.equal(supabaseClient._tables.CallLog?.length ?? 0, 0);
  });
});

test("POST /webhooks/twilio/voice returns the clinic's configured greeting when the forwarded number resolves", async () => {
  const supabaseClient = createTableStub({
    PhoneNumberRoute: [{ id: "route-1", clinicId: "clinic-1", originalNumber: "+919999999999", isActive: true }],
    Clinic: [
      {
        id: "clinic-1",
        name: "Nirmaya Clinic",
        settings: {
          communication: { voiceGreetingTemplate: "Hi, you've reached {{clinicName}}. We'll text you shortly." },
        },
      },
    ],
  });
  const twilioClient = createTwilioStub();
  const app = createApp({
    supabaseClient,
    nettuClient: null,
    firebaseAdminApp: null,
    stripeClient: null,
    openaiClient: null,
    twilioClient,
  });

  await withServer(app, async ({ request }) => {
    const response = await request("/webhooks/twilio/voice", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", "x-twilio-signature": "valid" },
      body: formBody({ CallSid: "CA1", From: "+919888888888", To: "+15551234567", ForwardedFrom: "+919999999999" }),
    });
    const body = await response.text();
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type"), /text\/xml/);
    assert.match(body, /Hi, you've reached Nirmaya Clinic\. We'll text you shortly\./);

    assert.equal(supabaseClient._tables.CallLog.length, 1);
    assert.equal(supabaseClient._tables.CallLog[0].clinicId, "clinic-1");
    assert.equal(supabaseClient._tables.CallLog[0].twilioCallSid, "CA1");
  });
});

test("POST /webhooks/twilio/voice falls back to a generic message when the number can't be resolved", async () => {
  const supabaseClient = createTableStub({ PhoneNumberRoute: [], Clinic: [] });
  const twilioClient = createTwilioStub();
  const app = createApp({
    supabaseClient,
    nettuClient: null,
    firebaseAdminApp: null,
    stripeClient: null,
    openaiClient: null,
    twilioClient,
  });

  await withServer(app, async ({ request }) => {
    const response = await request("/webhooks/twilio/voice", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", "x-twilio-signature": "valid" },
      body: formBody({ CallSid: "CA1", From: "+919888888888", To: "+15559999999" }),
    });
    const body = await response.text();
    assert.equal(response.status, 200);
    assert.match(body, /couldn't connect your call/);
    assert.equal(supabaseClient._tables.CallLog?.length ?? 0, 0);
  });
});

test("POST /webhooks/twilio/voice is idempotent for a redelivered CallSid", async () => {
  const supabaseClient = createTableStub({
    PhoneNumberRoute: [{ id: "route-1", clinicId: "clinic-1", originalNumber: "+919999999999", isActive: true }],
    Clinic: [{ id: "clinic-1", name: "Nirmaya Clinic", settings: {} }],
  });
  const twilioClient = createTwilioStub();
  const app = createApp({
    supabaseClient,
    nettuClient: null,
    firebaseAdminApp: null,
    stripeClient: null,
    openaiClient: null,
    twilioClient,
  });

  await withServer(app, async ({ request }) => {
    const fields = { CallSid: "CA1", From: "+919888888888", To: "+15551234567", ForwardedFrom: "+919999999999" };
    for (let i = 0; i < 2; i += 1) {
      await request("/webhooks/twilio/voice", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded", "x-twilio-signature": "valid" },
        body: formBody(fields),
      });
    }
    assert.equal(supabaseClient._tables.CallLog.length, 1);
  });
});

test("POST /webhooks/twilio/voice-status sends the configured missed-call follow-up once the call completes", async () => {
  const supabaseClient = createTableStub({
    CallLog: [
      {
        id: "call-1",
        clinicId: "clinic-1",
        phone: "+919888888888",
        twilioCallSid: "CA1",
        outcome: "info",
        durationSec: 0,
      },
    ],
    Clinic: [
      {
        id: "clinic-1",
        name: "Nirmaya Clinic",
        phone: "+919999999999",
        settings: {
          communication: {
            channelsEnabled: ["sms"],
            workflows: [
              {
                id: "missed-call-sms",
                trigger: "missed_call_followup",
                channel: "sms",
                offsetMinutes: 0,
                enabled: true,
                template: "Sorry we missed you at {{clinicName}}! Book here: https://book.example/{{clinicName}}",
              },
            ],
          },
        },
      },
    ],
  });
  const twilioClient = createTwilioStub();
  const app = createApp({
    supabaseClient,
    nettuClient: null,
    firebaseAdminApp: null,
    stripeClient: null,
    openaiClient: null,
    twilioClient,
  });

  await withServer(app, async ({ request }) => {
    const response = await request("/webhooks/twilio/voice-status", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", "x-twilio-signature": "valid" },
      body: formBody({ CallSid: "CA1", CallStatus: "completed", CallDuration: "12", From: "+919888888888" }),
    });
    assert.equal(response.status, 200);
    assert.equal(twilioClient.calls.sendSms.length, 1);
    assert.equal(twilioClient.calls.sendSms[0].to, "+919888888888");
    assert.match(twilioClient.calls.sendSms[0].body, /Sorry we missed you at Nirmaya Clinic!/);
  });
});

test("POST /webhooks/twilio/voice-status skips the follow-up when no workflow is configured", async () => {
  const supabaseClient = createTableStub({
    CallLog: [
      {
        id: "call-1",
        clinicId: "clinic-1",
        phone: "+919888888888",
        twilioCallSid: "CA1",
        outcome: "info",
        durationSec: 0,
      },
    ],
    Clinic: [{ id: "clinic-1", name: "Nirmaya Clinic", settings: {} }],
  });
  const twilioClient = createTwilioStub();
  const app = createApp({
    supabaseClient,
    nettuClient: null,
    firebaseAdminApp: null,
    stripeClient: null,
    openaiClient: null,
    twilioClient,
  });

  await withServer(app, async ({ request }) => {
    const response = await request("/webhooks/twilio/voice-status", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", "x-twilio-signature": "valid" },
      body: formBody({ CallSid: "CA1", CallStatus: "completed", From: "+919888888888" }),
    });
    assert.equal(response.status, 200);
    assert.equal(twilioClient.calls.sendSms.length, 0);
  });
});

test("POST /webhooks/twilio/whatsapp-inbound routes a patient message into the Thread/ChatMsg inbox", async () => {
  const supabaseClient = createTableStub({
    Clinic: [{ id: "clinic-1", name: "Nirmaya Clinic", whatsappFrom: "+19789069398" }],
  });
  const twilioClient = createTwilioStub();
  const app = createApp({
    supabaseClient,
    nettuClient: null,
    firebaseAdminApp: null,
    stripeClient: null,
    openaiClient: null,
    twilioClient,
  });

  await withServer(app, async ({ request }) => {
    const response = await request("/webhooks/twilio/whatsapp-inbound", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", "x-twilio-signature": "valid" },
      body: formBody({
        From: "whatsapp:+919888888888",
        To: "whatsapp:+19789069398",
        Body: "Can I reschedule my appointment?",
        MessageSid: "SM1",
      }),
    });
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type"), /text\/xml/);

    assert.equal(supabaseClient._tables.Patient.length, 1);
    assert.equal(supabaseClient._tables.Patient[0].contactNumber, "+919888888888");

    assert.equal(supabaseClient._tables.Thread.length, 1);
    const thread = supabaseClient._tables.Thread[0];
    assert.equal(thread.clinicId, "clinic-1");
    assert.equal(thread.contactPhone, "+919888888888");
    assert.equal(thread.channel, "whatsapp");
    assert.equal(thread.unreadCount, 1);

    // No assistantModel configured at all (deployment-level, not plan-gated)
    // still gets a structured fallback reply now — see the Phase 1 tests
    // below for the plan-gated cases. Two ChatMsg rows: the inbound message,
    // and the automated structured reply.
    assert.equal(supabaseClient._tables.ChatMsg.length, 2);
    const inbound = supabaseClient._tables.ChatMsg.find((m) => m.direction === "inbound");
    assert.equal(inbound.body, "Can I reschedule my appointment?");
    assert.equal(inbound.waMessageId, "SM1");
    const outbound = supabaseClient._tables.ChatMsg.find((m) => m.direction === "outbound");
    assert.match(outbound.body, /Nirmaya Clinic/);

    // One inbound + one outbound (the structured reply) WaLog entry now.
    assert.equal(supabaseClient._tables.WaLog.length, 2);
    assert.equal(supabaseClient._tables.WaLog.filter((w) => w.direction === "inbound").length, 1);
  });
});

test("POST /webhooks/twilio/whatsapp-inbound classifies and stores real AI triage on the thread when OpenAI is configured", async () => {
  const supabaseClient = createTableStub({
    Clinic: [{ id: "clinic-1", name: "Nirmaya Clinic", whatsappFrom: "+19789069398" }],
  });
  const twilioClient = createTwilioStub();
  const openaiClient = createOpenaiStub({
    content: JSON.stringify({ triage: "critical", summary: "Patient reports chest pain." }),
  });
  const app = createApp({
    supabaseClient,
    nettuClient: null,
    firebaseAdminApp: null,
    stripeClient: null,
    openaiClient,
    twilioClient,
  });

  await withServer(app, async ({ request }) => {
    const response = await request("/webhooks/twilio/whatsapp-inbound", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", "x-twilio-signature": "valid" },
      body: formBody({
        From: "whatsapp:+919888888888",
        To: "whatsapp:+19789069398",
        Body: "I have chest pain, please help",
        MessageSid: "SM-triage-1",
      }),
    });
    assert.equal(response.status, 200);

    const thread = supabaseClient._tables.Thread[0];
    assert.equal(thread.triage, "critical");
    assert.equal(thread.aiSummary, "Patient reports chest pain.");
  });
});

test("POST /webhooks/twilio/whatsapp-inbound reuses the same open thread across multiple messages", async () => {
  const supabaseClient = createTableStub({
    Clinic: [{ id: "clinic-1", name: "Nirmaya Clinic", whatsappFrom: "+19789069398" }],
  });
  const twilioClient = createTwilioStub();
  const app = createApp({
    supabaseClient,
    nettuClient: null,
    firebaseAdminApp: null,
    stripeClient: null,
    openaiClient: null,
    twilioClient,
  });

  await withServer(app, async ({ request }) => {
    const fields = { From: "whatsapp:+919888888888", To: "whatsapp:+19789069398", Body: "hi" };
    await request("/webhooks/twilio/whatsapp-inbound", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", "x-twilio-signature": "valid" },
      body: formBody({ ...fields, MessageSid: "SM1" }),
    });
    await request("/webhooks/twilio/whatsapp-inbound", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", "x-twilio-signature": "valid" },
      body: formBody({ ...fields, Body: "still there?", MessageSid: "SM2" }),
    });

    assert.equal(supabaseClient._tables.Thread.length, 1);
    assert.equal(supabaseClient._tables.Thread[0].unreadCount, 2);
    // 2 inbound + 2 structured-fallback outbound replies (see the ChatMsg
    // count note on the test above — same behavior change).
    assert.equal(supabaseClient._tables.ChatMsg.length, 4);
  });
});

test("POST /webhooks/twilio/whatsapp-inbound replies empty TwiML when no clinic owns the receiving number", async () => {
  const supabaseClient = createTableStub({ Clinic: [] });
  const twilioClient = createTwilioStub();
  const app = createApp({
    supabaseClient,
    nettuClient: null,
    firebaseAdminApp: null,
    stripeClient: null,
    openaiClient: null,
    twilioClient,
  });

  await withServer(app, async ({ request }) => {
    const response = await request("/webhooks/twilio/whatsapp-inbound", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", "x-twilio-signature": "valid" },
      body: formBody({ From: "whatsapp:+919888888888", To: "whatsapp:+10000000000", Body: "hi" }),
    });
    assert.equal(response.status, 200);
    assert.equal(supabaseClient._tables.Thread?.length ?? 0, 0);
  });
});

// Phase 1: entitlementsForPlan() gates whether the full conversational
// WhatsApp agent runs, or a clinic gets the structured/CTA fallback instead —
// see webhooks-twilio.js's whatsapp-inbound handler and buildStructuredFallbackReply.
function whatsappAgentModel(text) {
  return new MockLanguageModelV3({
    doGenerate: async () => ({
      finishReason: "stop",
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      content: [{ type: "text", text }],
      warnings: [],
    }),
  });
}

test("POST /webhooks/twilio/whatsapp-inbound sends the structured fallback for a basic-plan clinic, never invoking the AI model", async () => {
  const supabaseClient = createTableStub({
    Clinic: [{ id: "clinic-1", name: "Nirmaya Clinic", whatsappFrom: "+19789069398", plan: { planId: "basic" } }],
  });
  const twilioClient = createTwilioStub();
  const app = createApp({
    supabaseClient,
    nettuClient: null,
    firebaseAdminApp: null,
    stripeClient: null,
    openaiClient: null,
    twilioClient,
    // If the entitlement gate is broken and this gets called anyway, doGenerate
    // throwing makes the failure obvious instead of silently "working" via a
    // reply that happens to look similar.
    assistantModel: new MockLanguageModelV3({
      doGenerate: async () => {
        throw new Error("the AI agent must not run for a basic-plan clinic");
      },
    }),
  });

  await withServer(app, async ({ request }) => {
    const response = await request("/webhooks/twilio/whatsapp-inbound", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", "x-twilio-signature": "valid" },
      body: formBody({ From: "whatsapp:+919888888888", To: "whatsapp:+19789069398", Body: "hi", MessageSid: "SM-basic-1" }),
    });
    assert.equal(response.status, 200);
    const outbound = supabaseClient._tables.ChatMsg.find((m) => m.direction === "outbound");
    assert.ok(outbound, "expected a structured fallback reply to be recorded");
    assert.match(outbound.body, /Nirmaya Clinic/);
  });
});

test("POST /webhooks/twilio/whatsapp-inbound invokes the full AI agent for a premium-plan clinic", async () => {
  const supabaseClient = createTableStub({
    Clinic: [{ id: "clinic-1", name: "Nirmaya Clinic", whatsappFrom: "+19789069398", plan: { planId: "premium" } }],
    Doctor: [{ id: "doc-1", clinicId: "clinic-1", fullName: "Dr. Priya", isActive: true }],
  });
  const twilioClient = createTwilioStub();
  const app = createApp({
    supabaseClient,
    nettuClient: {},
    firebaseAdminApp: null,
    stripeClient: null,
    openaiClient: null,
    twilioClient,
    assistantModel: whatsappAgentModel("Sure, I can help with that."),
  });

  await withServer(app, async ({ request }) => {
    const response = await request("/webhooks/twilio/whatsapp-inbound", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", "x-twilio-signature": "valid" },
      body: formBody({ From: "whatsapp:+919888888888", To: "whatsapp:+19789069398", Body: "hi", MessageSid: "SM-premium-1" }),
    });
    assert.equal(response.status, 200);
    const outbound = supabaseClient._tables.ChatMsg.find((m) => m.direction === "outbound");
    assert.equal(outbound.body, "Sure, I can help with that.");
  });
});

test("POST /webhooks/twilio/whatsapp-inbound: custom plan without the ai_whatsapp_agent addon gets the fallback, with it gets the AI agent", async () => {
  const twilioClient = createTwilioStub();

  await withServer(
    createApp({
      supabaseClient: createTableStub({
        Clinic: [{ id: "clinic-1", name: "Nirmaya Clinic", whatsappFrom: "+19789069398", plan: { planId: "custom", addonIds: ["smart_ivr"] } }],
      }),
      nettuClient: null,
      firebaseAdminApp: null,
      stripeClient: null,
      openaiClient: null,
      twilioClient,
      assistantModel: new MockLanguageModelV3({
        doGenerate: async () => {
          throw new Error("must not run without the ai_whatsapp_agent addon");
        },
      }),
    }),
    async ({ request }) => {
      const response = await request("/webhooks/twilio/whatsapp-inbound", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded", "x-twilio-signature": "valid" },
        body: formBody({ From: "whatsapp:+919888888888", To: "whatsapp:+19789069398", Body: "hi", MessageSid: "SM-custom-no-addon" }),
      });
      assert.equal(response.status, 200);
    },
  );

  const supabaseClientWithAddon = createTableStub({
    Clinic: [{ id: "clinic-1", name: "Nirmaya Clinic", whatsappFrom: "+19789069398", plan: { planId: "custom", addonIds: ["ai_whatsapp_agent"] } }],
    Doctor: [{ id: "doc-1", clinicId: "clinic-1", fullName: "Dr. Priya", isActive: true }],
  });
  await withServer(
    createApp({
      supabaseClient: supabaseClientWithAddon,
      nettuClient: {},
      firebaseAdminApp: null,
      stripeClient: null,
      openaiClient: null,
      twilioClient,
      assistantModel: whatsappAgentModel("Here's your appointment info."),
    }),
    async ({ request }) => {
      const response = await request("/webhooks/twilio/whatsapp-inbound", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded", "x-twilio-signature": "valid" },
        body: formBody({ From: "whatsapp:+919888888888", To: "whatsapp:+19789069398", Body: "hi", MessageSid: "SM-custom-with-addon" }),
      });
      assert.equal(response.status, 200);
      const outbound = supabaseClientWithAddon._tables.ChatMsg.find((m) => m.direction === "outbound");
      assert.equal(outbound.body, "Here's your appointment info.");
    },
  );
});

// ─── /webhooks/stripe ────────────────────────────────────────────────────────

test("POST /webhooks/stripe rejects a bad signature and accepts a valid event", async () => {
  const supabaseClient = createTableStub({
    Invoice: [{ id: "inv_1", clinicId: "clinic-1", stripeCheckoutSessionId: "cs_test_123", status: "pending" }],
  });

  const badSigApp = createApp({
    supabaseClient,
    nettuClient: null,
    stripeClient: createStripeStub({ shouldRejectSignature: true }),
  });

  await withServer(badSigApp, async ({ request }) => {
    const response = await request("/webhooks/stripe", {
      method: "POST",
      headers: { "Content-Type": "application/json", "stripe-signature": "bad" },
      body: JSON.stringify({}),
    });
    assert.equal(response.status, 400);
  });

  const goodApp = createApp({
    supabaseClient,
    nettuClient: null,
    stripeClient: createStripeStub({
      event: {
        type: "checkout.session.completed",
        data: { object: { id: "cs_test_123", payment_intent: "pi_test_123" } },
      },
    }),
  });

  await withServer(goodApp, async ({ request }) => {
    const response = await request("/webhooks/stripe", {
      method: "POST",
      headers: { "Content-Type": "application/json", "stripe-signature": "valid" },
      body: JSON.stringify({}),
    });
    const body = await readJson(response);

    assert.equal(response.status, 200);
    assert.deepEqual(body, { received: true });
    assert.equal(supabaseClient._tables.Invoice[0].status, "paid");
  });
});

// ─── /api/v1/public (schedurx-form-agent's booking API) ────────────────────────

function makePublicNettuStub() {
  return {
    async getBookingSlots() {
      const start = Date.now() + 24 * 60 * 60 * 1000;
      return [{ start, duration: 30 * 60 * 1000 }];
    },
    async createEvent() {
      return { id: "nettu-event-public-1" };
    },
    async deleteEvent() {
      return { id: "nettu-event-public-1" };
    },
  };
}

function publicClinicRow(overrides = {}) {
  return {
    id: "clinic-1",
    name: "Nirmaya Clinic",
    phone: "+919999999999",
    status: "active",
    schedulerServiceId: "svc-1",
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
    settings: {},
    ...overrides,
  };
}

test("GET /api/v1/public/clinic/:clinicId returns the doctor roster with no auth, 404s for an unknown clinic", async () => {
  const supabaseClient = createTableStub({
    Clinic: [publicClinicRow()],
    Doctor: [
      {
        id: "doc-1",
        clinicId: "clinic-1",
        fullName: "Dr. Priya",
        isActive: true,
        specialty: "General Physician",
        schedulerDoctorId: "n-doc-1",
      },
    ],
  });
  const app = createApp({
    supabaseClient,
    nettuClient: makePublicNettuStub(),
    firebaseAdminApp: null,
    stripeClient: null,
    openaiClient: null,
  });

  await withServer(app, async ({ request }) => {
    const ok = await request("/api/v1/public/clinic/clinic-1");
    const okBody = await readJson(ok);
    assert.equal(ok.status, 200);
    assert.equal(okBody.data.name, "Nirmaya Clinic");
    assert.equal(okBody.data.doctors.length, 1);
    assert.equal(okBody.data.doctors[0].id, "doc-1");
    assert.equal(okBody.data.schedulerServiceId, undefined);
    assert.equal(okBody.data.doctors[0].schedulerDoctorId, undefined);

    const missing = await request("/api/v1/public/clinic/does-not-exist");
    assert.equal(missing.status, 404);
  });
});

test("GET /api/v1/public/slots wraps availabilitySvc and rejects missing query params", async () => {
  const supabaseClient = createTableStub({
    Clinic: [publicClinicRow()],
    Doctor: [
      {
        id: "doc-1",
        clinicId: "clinic-1",
        fullName: "Dr. Priya",
        isActive: true,
        schedulerDoctorId: "n-doc-1",
        schedulerCalendarId: "n-cal-1",
      },
    ],
  });
  const app = createApp({
    supabaseClient,
    nettuClient: makePublicNettuStub(),
    firebaseAdminApp: null,
    stripeClient: null,
    openaiClient: null,
  });

  await withServer(app, async ({ request }) => {
    const missing = await request("/api/v1/public/slots?clinicId=clinic-1");
    assert.equal(missing.status, 422);

    const response = await request("/api/v1/public/slots?clinicId=clinic-1&doctorId=doc-1");
    const body = await readJson(response);
    assert.equal(response.status, 200, JSON.stringify(body));
    assert.equal(body.data.slots.length, 1);
    assert.equal(body.data.slots[0].doctorId, "doc-1");
  });
});

test("POST /api/v1/public/appointments books a real appointment, creating the Patient and firing the confirmation workflow", async () => {
  const supabaseClient = createTableStub({
    Clinic: [publicClinicRow()],
    Doctor: [
      {
        id: "doc-1",
        clinicId: "clinic-1",
        fullName: "Dr. Priya",
        isActive: true,
        schedulerDoctorId: "n-doc-1",
        schedulerCalendarId: "n-cal-1",
      },
    ],
  });
  const twilioClient = createTwilioStub();
  const app = createApp({
    supabaseClient,
    nettuClient: makePublicNettuStub(),
    firebaseAdminApp: null,
    stripeClient: null,
    openaiClient: null,
    twilioClient,
  });

  await withServer(app, async ({ request }) => {
    const missing = await request("/api/v1/public/appointments", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ clinicId: "clinic-1" }),
    });
    assert.equal(missing.status, 422);

    const badPhone = await request("/api/v1/public/appointments", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        clinicId: "clinic-1",
        doctorId: "doc-1",
        start: new Date(Date.now() + 48 * 60 * 60 * 1000).toISOString(),
        patient: { phone: "12345", fullName: "Test Patient" },
      }),
    });
    assert.equal(badPhone.status, 422);

    const start = new Date(Date.now() + 48 * 60 * 60 * 1000).toISOString();
    const response = await request("/api/v1/public/appointments", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        clinicId: "clinic-1",
        doctorId: "doc-1",
        start,
        // Deliberately a bare 10-digit number starting with "91" — regression
        // coverage for the normalizePhone bug that mis-stripped it as a
        // country-code prefix (see test/routes/api-v1-public.test.js).
        patient: { phone: "9123456780", fullName: "Test Patient" },
        reason: "Fever",
      }),
    });
    const body = await readJson(response);
    assert.equal(response.status, 201, JSON.stringify(body));
    assert.equal(body.data.appointment.doctorId, "doc-1");
    assert.equal(body.data.patient.contactNumber, "+919123456780");
    assert.equal(supabaseClient._tables.Appointment[0].source, "patient_web");
    assert.equal(supabaseClient._tables.Patient.length, 1);
  });
});

test("GET/PATCH/DELETE /api/v1/public/appointments/:id require clinicId and scope strictly to it", async () => {
  const futureStart = new Date(Date.now() + 72 * 60 * 60 * 1000).toISOString();
  const supabaseClient = createTableStub({
    Clinic: [publicClinicRow(), publicClinicRow({ id: "clinic-2", name: "Other Clinic" })],
    Doctor: [
      {
        id: "doc-1",
        clinicId: "clinic-1",
        fullName: "Dr. Priya",
        isActive: true,
        schedulerDoctorId: "n-doc-1",
        schedulerCalendarId: "n-cal-1",
      },
    ],
    Patient: [{ id: "pat-1", clinicId: "clinic-1", fullName: "Test Patient", contactNumber: "+919876543210" }],
    Appointment: [
      {
        id: "apt_public_1",
        clinicId: "clinic-1",
        doctorId: "doc-1",
        patientId: "pat-1",
        timeslot: futureStart,
        status: "booked",
        auditHistory: [],
      },
    ],
  });
  const app = createApp({
    supabaseClient,
    nettuClient: makePublicNettuStub(),
    firebaseAdminApp: null,
    stripeClient: null,
    openaiClient: null,
  });

  await withServer(app, async ({ request }) => {
    const noClinicId = await request("/api/v1/public/appointments/apt_public_1");
    assert.equal(noClinicId.status, 422);

    const wrongClinic = await request("/api/v1/public/appointments/apt_public_1?clinicId=clinic-2");
    assert.equal(wrongClinic.status, 404);

    const view = await request("/api/v1/public/appointments/apt_public_1?clinicId=clinic-1");
    const viewBody = await readJson(view);
    assert.equal(view.status, 200);
    assert.equal(viewBody.data.doctor.id, "doc-1");
    assert.equal(viewBody.data.patient.contactNumber, "+919876543210");

    const newStart = new Date(Date.now() + 96 * 60 * 60 * 1000).toISOString();
    const rescheduled = await request("/api/v1/public/appointments/apt_public_1", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ clinicId: "clinic-1", newStart }),
    });
    const rescheduledBody = await readJson(rescheduled);
    assert.equal(rescheduled.status, 200, JSON.stringify(rescheduledBody));

    const cancelled = await request("/api/v1/public/appointments/apt_public_1", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ clinicId: "clinic-1" }),
    });
    assert.equal(cancelled.status, 200);
    const { data: row } = await supabaseClient.from("Appointment").eq("id", "apt_public_1").maybeSingle();
    assert.equal(row.status, "cancelled");
  });
});
