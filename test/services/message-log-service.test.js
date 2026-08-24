const { test, describe } = require("node:test");
const assert = require("node:assert/strict");

process.env.NODE_ENV = "test";
process.env.TOOLS_API_KEY = "test-tools-api-key-with-32-characters";
process.env.INTERNAL_API_KEY = "test-internal-api-key-with-32-chars";
process.env.SUPABASE_URL = "https://example.supabase.co";
process.env.SUPABASE_SERVICE_ROLE_KEY = "service-role-key";
process.env.NETTU_BASE_URL = "https://nettu.example.test";
process.env.NETTU_API_KEY = "nettu-api-key";

const messageLogSvc = require("../../src/services/message-log-service");
const { createTableStub } = require("../helpers/supabase-table-stub");

describe("recordSent / updateStatus", () => {
  test("records a queued row, then a real status-callback updates it in place", async () => {
    const supabaseClient = createTableStub({ MessageLog: [] });

    await messageLogSvc.recordSent(supabaseClient, {
      sid: "SM123",
      clinicId: "clinic-1",
      channel: "whatsapp",
      toPhone: "+919999999999",
      purpose: "booking_confirmed",
      initialStatus: "queued",
    });

    assert.equal(supabaseClient._tables.MessageLog.length, 1);
    const row = supabaseClient._tables.MessageLog[0];
    assert.equal(row.providerSid, "SM123");
    assert.equal(row.status, "queued");
    assert.equal(row.purpose, "booking_confirmed");

    await messageLogSvc.updateStatus(supabaseClient, { sid: "SM123", status: "delivered" });
    assert.equal(supabaseClient._tables.MessageLog[0].status, "delivered");
    assert.equal(supabaseClient._tables.MessageLog[0].errorCode, null);
  });

  test("updateStatus records the error code/message on a failed delivery", async () => {
    const supabaseClient = createTableStub({
      MessageLog: [{ id: "msglog_1", providerSid: "SM456", status: "sent", channel: "whatsapp" }],
    });

    await messageLogSvc.updateStatus(supabaseClient, {
      sid: "SM456",
      status: "undelivered",
      errorCode: "63016",
      errorMessage: "outside allowed window",
    });

    const row = supabaseClient._tables.MessageLog.find((r) => r.providerSid === "SM456");
    assert.equal(row.status, "undelivered");
    assert.equal(row.errorCode, "63016");
  });

  test("updateStatus for an unknown sid is a silent no-op, not an error", async () => {
    const supabaseClient = createTableStub({ MessageLog: [] });
    await assert.doesNotReject(() => messageLogSvc.updateStatus(supabaseClient, { sid: "SM-unknown", status: "delivered" }));
  });
});

describe("listRecentFailures", () => {
  test("returns only undelivered/failed rows within the window, most recent first", async () => {
    const now = Date.now();
    const supabaseClient = createTableStub({
      MessageLog: [
        { id: "1", clinicId: "clinic-1", status: "delivered", createdAt: new Date(now).toISOString() },
        { id: "2", clinicId: "clinic-1", status: "failed", createdAt: new Date(now - 60_000).toISOString() },
        { id: "3", clinicId: "clinic-1", status: "undelivered", createdAt: new Date(now - 30_000).toISOString() },
        { id: "4", clinicId: "clinic-2", status: "failed", createdAt: new Date(now - 45_000).toISOString() },
      ],
    });

    const failures = await messageLogSvc.listRecentFailures(supabaseClient, { clinicId: "clinic-1" });
    assert.deepEqual(
      failures.map((f) => f.id),
      ["3", "2"],
    );
  });
});
