const { test, describe } = require("node:test");
const assert = require("node:assert/strict");

const { createTask, toggleTask, deleteTask } = require("../../src/services/task-service");
const { createTableStub } = require("../helpers/supabase-table-stub");

function makeDoctor(overrides = {}) {
  return { id: "doc-1", schedulerDoctorId: "nettu-user-1", schedulerCalendarId: "nettu-cal-1", ...overrides };
}

function makeNettu({ createFails = false } = {}) {
  const calls = { createEvent: [], deleteEvent: [] };
  return {
    calls,
    async createEvent(userId, opts) {
      calls.createEvent.push({ userId, opts });
      if (createFails) throw new Error("nettu unreachable");
      return { id: "nettu-event-1" };
    },
    async deleteEvent(userId, eventId) {
      calls.deleteEvent.push({ userId, eventId });
      return { id: eventId };
    },
  };
}

describe("createTask", () => {
  test("creates a non-busy, fire-at-due-time nettu reminder when dueAt + doctor are given", async () => {
    const supabaseClient = createTableStub();
    const nettuClient = makeNettu();

    const task = await createTask(supabaseClient, {
      clinicId: "clinic-1",
      createdByStaffId: "staff-1",
      title: "Visit bank",
      dueAt: "2026-08-19T10:30:00.000Z",
      nettuClient,
      doctor: makeDoctor(),
    });

    assert.equal(nettuClient.calls.createEvent.length, 1);
    const { userId, opts } = nettuClient.calls.createEvent[0];
    assert.equal(userId, "nettu-user-1");
    assert.equal(opts.calendarId, "nettu-cal-1");
    assert.equal(opts.busy, false);
    assert.deepEqual(opts.reminders, [{ delta: 0, identifier: task.id }]);
    assert.equal(opts.metadata.kind, "task");
    assert.equal(opts.metadata.taskId, task.id);
    assert.equal(task.schedulerEventId, "nettu-event-1");
  });

  test("skips nettu entirely when there's no dueAt", async () => {
    const supabaseClient = createTableStub();
    const nettuClient = makeNettu();

    const task = await createTask(supabaseClient, {
      clinicId: "clinic-1",
      createdByStaffId: "staff-1",
      title: "Call the lab",
      nettuClient,
      doctor: makeDoctor(),
    });

    assert.equal(nettuClient.calls.createEvent.length, 0);
    // Omitted entirely (not written as null) — including the key at all would
    // break inserts on a DB that hasn't had the schedulerEventId column added.
    assert.equal(task.schedulerEventId, undefined);
  });

  test("still creates the task when the nettu reminder fails", async () => {
    const supabaseClient = createTableStub();
    const nettuClient = makeNettu({ createFails: true });

    const task = await createTask(supabaseClient, {
      clinicId: "clinic-1",
      createdByStaffId: "staff-1",
      title: "Visit bank",
      dueAt: "2026-08-19T10:30:00.000Z",
      nettuClient,
      doctor: makeDoctor(),
      log: { warn: () => {} },
    });

    assert.equal(task.title, "Visit bank");
    assert.equal(task.schedulerEventId, undefined);
  });
});

describe("toggleTask", () => {
  test("cancels the nettu reminder when marking a task done", async () => {
    const supabaseClient = createTableStub({
      Task: [{ id: "task-1", clinicId: "clinic-1", status: "open", schedulerEventId: "nettu-event-1" }],
    });
    const nettuClient = makeNettu();

    await toggleTask(supabaseClient, "clinic-1", "task-1", true, { nettuClient });

    assert.equal(nettuClient.calls.deleteEvent.length, 1);
    assert.equal(nettuClient.calls.deleteEvent[0].eventId, "nettu-event-1");
  });

  test("does not cancel anything when reopening a task", async () => {
    const supabaseClient = createTableStub({
      Task: [{ id: "task-1", clinicId: "clinic-1", status: "done", schedulerEventId: "nettu-event-1" }],
    });
    const nettuClient = makeNettu();

    await toggleTask(supabaseClient, "clinic-1", "task-1", false, { nettuClient });

    assert.equal(nettuClient.calls.deleteEvent.length, 0);
  });
});

describe("deleteTask", () => {
  test("cancels the nettu reminder when a task with one is deleted", async () => {
    const supabaseClient = createTableStub({
      Task: [{ id: "task-1", clinicId: "clinic-1", schedulerEventId: "nettu-event-1" }],
    });
    const nettuClient = makeNettu();

    await deleteTask(supabaseClient, "clinic-1", "task-1", { nettuClient });

    assert.equal(nettuClient.calls.deleteEvent.length, 1);
    assert.equal(nettuClient.calls.deleteEvent[0].eventId, "nettu-event-1");
    assert.equal(supabaseClient._tables.Task.length, 0);
  });
});
