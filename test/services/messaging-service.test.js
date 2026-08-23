const { test, describe } = require("node:test");
const assert = require("node:assert/strict");

const messagingSvc = require("../../src/services/messaging-service");
const { createTableStub } = require("../helpers/supabase-table-stub");
const { createTwilioStub } = require("../helpers/twilio-stub");

// Doctor isolation (Phase 4): Thread.scope + Thread.doctorId, filtered by
// messaging-service.js's isVisibleToStaff. A general (or unassigned) thread
// stays visible to every doctor; a booking-scoped thread is only visible to
// the doctor it's tied to. Owner/receptionist (or no staffContext at all —
// internal/webhook callers) always see everything.

function threadFixtures() {
  return [
    { id: "thread-general", clinicId: "clinic-1", scope: "general", doctorId: null, contactPhone: "+919999999991", channel: "whatsapp", status: "open", unreadCount: 0, lastMessageAt: "2026-08-20T00:00:00Z" },
    { id: "thread-doc-a", clinicId: "clinic-1", scope: "booking", doctorId: "doc-a", appointmentId: "apt_a", contactPhone: "+919999999992", channel: "whatsapp", status: "open", unreadCount: 0, lastMessageAt: "2026-08-21T00:00:00Z" },
    { id: "thread-doc-b", clinicId: "clinic-1", scope: "booking", doctorId: "doc-b", appointmentId: "apt_b", contactPhone: "+919999999993", channel: "whatsapp", status: "open", unreadCount: 0, lastMessageAt: "2026-08-22T00:00:00Z" },
  ];
}

describe("listThreads doctor isolation", () => {
  test("owner sees every thread, regardless of doctorId", async () => {
    const supabaseClient = createTableStub({ Thread: threadFixtures() });
    const threads = await messagingSvc.listThreads(supabaseClient, "clinic-1", { staffContext: { role: "owner" } });
    assert.equal(threads.length, 3);
  });

  test("a doctor sees their own booking-scoped thread plus the general one, not the other doctor's", async () => {
    const supabaseClient = createTableStub({ Thread: threadFixtures() });
    const threads = await messagingSvc.listThreads(supabaseClient, "clinic-1", { staffContext: { role: "doctor", doctorId: "doc-a" } });
    const ids = threads.map((t) => t.id).sort();
    assert.deepEqual(ids, ["thread-doc-a", "thread-general"]);
  });

  test("no staffContext at all (internal/webhook callers) sees everything, same as owner", async () => {
    const supabaseClient = createTableStub({ Thread: threadFixtures() });
    const threads = await messagingSvc.listThreads(supabaseClient, "clinic-1", {});
    assert.equal(threads.length, 3);
  });
});

describe("getThread doctor isolation", () => {
  test("404s (THREAD_NOT_FOUND) rather than 403 for a doctor reading another doctor's booking thread", async () => {
    const supabaseClient = createTableStub({ Thread: threadFixtures() });
    await assert.rejects(
      () => messagingSvc.getThread(supabaseClient, "clinic-1", "thread-doc-b", { role: "doctor", doctorId: "doc-a" }),
      (err) => err.code === "THREAD_NOT_FOUND" && err.statusCode === 404,
    );
  });

  test("a doctor can read their own booking thread and the general one", async () => {
    const supabaseClient = createTableStub({ Thread: threadFixtures() });
    const own = await messagingSvc.getThread(supabaseClient, "clinic-1", "thread-doc-a", { role: "doctor", doctorId: "doc-a" });
    assert.equal(own.id, "thread-doc-a");
    const general = await messagingSvc.getThread(supabaseClient, "clinic-1", "thread-general", { role: "doctor", doctorId: "doc-a" });
    assert.equal(general.id, "thread-general");
  });
});

describe("sendReply / escalate / markRead respect doctor isolation", () => {
  test("sendReply refuses to reply into another doctor's booking thread", async () => {
    const supabaseClient = createTableStub({ Thread: threadFixtures(), ChatMsg: [] });
    await assert.rejects(
      () =>
        messagingSvc.sendReply(
          supabaseClient,
          { clinicId: "clinic-1", threadId: "thread-doc-b", staffId: "staff-a", body: "hi", staffContext: { role: "doctor", doctorId: "doc-a" } },
          null,
          createTwilioStub(),
        ),
      (err) => err.code === "THREAD_NOT_FOUND",
    );
    assert.equal(supabaseClient._tables.ChatMsg.length, 0, "no message should be sent or persisted");
  });

  test("sendReply succeeds into the doctor's own booking thread", async () => {
    const supabaseClient = createTableStub({ Thread: threadFixtures(), ChatMsg: [] });
    const message = await messagingSvc.sendReply(
      supabaseClient,
      { clinicId: "clinic-1", threadId: "thread-doc-a", staffId: "staff-a", body: "hi", staffContext: { role: "doctor", doctorId: "doc-a" } },
      null,
      createTwilioStub(),
    );
    assert.equal(message.body, "hi");
  });

  test("escalate refuses another doctor's booking thread", async () => {
    const supabaseClient = createTableStub({ Thread: threadFixtures() });
    await assert.rejects(
      () => messagingSvc.escalate(supabaseClient, "clinic-1", "thread-doc-b", { role: "doctor", doctorId: "doc-a" }),
      (err) => err.code === "THREAD_NOT_FOUND",
    );
    assert.equal(supabaseClient._tables.Thread.find((t) => t.id === "thread-doc-b").status, "open");
  });

  test("markRead refuses another doctor's booking thread", async () => {
    const supabaseClient = createTableStub({ Thread: [{ ...threadFixtures()[2], unreadCount: 3 }] });
    await assert.rejects(
      () => messagingSvc.markRead(supabaseClient, "clinic-1", "thread-doc-b", { role: "doctor", doctorId: "doc-a" }),
      (err) => err.code === "THREAD_NOT_FOUND",
    );
    assert.equal(supabaseClient._tables.Thread[0].unreadCount, 3);
  });
});

describe("findOrCreateThread", () => {
  test("resolves the existing general thread, not a co-existing booking-scoped one for the same contact", async () => {
    const supabaseClient = createTableStub({
      Thread: [
        { id: "thread_general", clinicId: "clinic-1", patientId: "pat-1", channel: "whatsapp", contactPhone: "+919999999994", status: "open", scope: "general" },
        { id: "thread_booking", clinicId: "clinic-1", patientId: "pat-1", doctorId: "doc-a", appointmentId: "apt_x", channel: "whatsapp", contactPhone: "+919999999994", status: "open", scope: "booking" },
      ],
    });
    const thread = await messagingSvc.findOrCreateThread(supabaseClient, { clinicId: "clinic-1", patientId: "pat-1", contactPhone: "+919999999994" });
    assert.equal(thread.id, "thread_general");
  });

  test("creates a new thread explicitly tagged scope:'general'", async () => {
    const supabaseClient = createTableStub({ Thread: [] });
    const thread = await messagingSvc.findOrCreateThread(supabaseClient, { clinicId: "clinic-1", patientId: "pat-1", contactPhone: "+919999999995" });
    assert.equal(thread.scope, "general");
    assert.equal(thread.doctorId, null);
    assert.equal(thread.appointmentId, null);
  });
});

describe("findOrCreateBookingThread", () => {
  test("creates a booking-scoped thread tied to the appointment's doctor", async () => {
    const supabaseClient = createTableStub({ Thread: [] });
    const thread = await messagingSvc.findOrCreateBookingThread(supabaseClient, {
      clinicId: "clinic-1",
      appointmentId: "apt_new",
      doctorId: "doc-a",
      patientId: "pat-1",
      contactPhone: "+919999999994",
    });
    assert.equal(thread.scope, "booking");
    assert.equal(thread.appointmentId, "apt_new");
    assert.equal(thread.doctorId, "doc-a");
  });

  test("is idempotent — a second call for the same appointment reuses the existing thread", async () => {
    const supabaseClient = createTableStub({ Thread: [] });
    const first = await messagingSvc.findOrCreateBookingThread(supabaseClient, {
      clinicId: "clinic-1",
      appointmentId: "apt_new",
      doctorId: "doc-a",
      patientId: "pat-1",
      contactPhone: "+919999999994",
    });
    const second = await messagingSvc.findOrCreateBookingThread(supabaseClient, {
      clinicId: "clinic-1",
      appointmentId: "apt_new",
      doctorId: "doc-a",
      patientId: "pat-1",
      contactPhone: "+919999999994",
    });
    assert.equal(second.id, first.id);
    assert.equal(supabaseClient._tables.Thread.length, 1);
  });
});
