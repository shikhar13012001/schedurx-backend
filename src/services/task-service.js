const { makeId } = require("../lib/ids");
const notificationSvc = require("./notification-service");
const pushSvc = require("./push-service");

function dbErr(msg) {
  return Object.assign(new Error(`DB error ${msg}`), { code: "DATABASE_ERROR", statusCode: 500 });
}
function notFound(id) {
  return Object.assign(new Error(`Task '${id}' not found`), { code: "TASK_NOT_FOUND", statusCode: 404 });
}

async function listTasks(supabaseClient, clinicId, staffId) {
  const { data, error } = await supabaseClient
    .from("Task")
    .select("*")
    .eq("clinicId", clinicId)
    .eq("assignedStaffId", staffId)
    .order("dueAt", { ascending: true, nullsFirst: false });
  if (error) throw dbErr(`listing tasks: ${error.message}`);
  return data ?? [];
}

// Creates a lightweight, non-busy nettu event purely to carry a reminder
// timer for a task's due time — never a real booking, so `busy: false` is
// load-bearing here: this must never make the carrier doctor look occupied.
// nettu has no calendarless/clinic-wide event option (every event needs a
// specific doctor's schedulerDoctorId/schedulerCalendarId), so the caller
// resolves which doctor's calendar to piggyback on and passes it in as
// `doctor`. A task is still useful without this — failures are logged and
// swallowed rather than failing task creation over a scheduler hiccup.
//
// Returns { schedulerEventId, failed } rather than a bare id/null — a task
// with no dueAt at all was never SUPPOSED to get a reminder (failed: false,
// nothing to warn about), which used to be indistinguishable from a real
// nettu failure (also null) — the caller couldn't tell "no due date given"
// from "due date given, reminder silently never got set", so a genuine
// failure was invisible to the staff member who'd reasonably assume it
// worked. notifyDueTasks below is the real safety net for a reminder that
// failed anyway — this return value is just what lets task creation itself
// say so immediately instead of staying silent.
async function maybeCreateReminderEvent({ nettuClient, doctor, clinicId, taskId, staffId, dueAt, log }) {
  if (!dueAt) return { schedulerEventId: null, failed: false };
  if (!nettuClient || !doctor?.schedulerDoctorId || !doctor?.schedulerCalendarId) {
    log?.warn?.({ taskId }, "[taskSvc] no scheduler/doctor calendar available — task saved without a reminder");
    return { schedulerEventId: null, failed: true };
  }
  try {
    const event = await nettuClient.createEvent(doctor.schedulerDoctorId, {
      calendarId: doctor.schedulerCalendarId,
      startTs: new Date(dueAt).getTime(),
      durationMs: 60_000,
      busy: false,
      metadata: { clinicId, taskId, staffId, kind: "task" },
      reminders: [{ delta: 0, identifier: taskId }],
    });
    return { schedulerEventId: event?.id ?? null, failed: !event?.id };
  } catch (err) {
    log?.warn?.({ err, taskId }, "[taskSvc] failed to create nettu reminder — task saved without one");
    return { schedulerEventId: null, failed: true };
  }
}

async function createTask(
  supabaseClient,
  { clinicId, assignedStaffId, createdByStaffId, title, description, dueAt, viaAI, nettuClient, doctor, log },
) {
  if (!title) throw Object.assign(new Error("title is required"), { code: "MISSING_FIELDS", statusCode: 422 });

  const now = new Date().toISOString();
  const id = makeId("task");
  const finalAssignedStaffId = assignedStaffId ?? createdByStaffId;
  const { schedulerEventId, failed: reminderFailed } = await maybeCreateReminderEvent({
    nettuClient,
    doctor,
    clinicId,
    taskId: id,
    staffId: finalAssignedStaffId,
    dueAt,
    log,
  });

  const { data, error } = await supabaseClient
    .from("Task")
    .insert({
      id,
      clinicId,
      assignedStaffId: finalAssignedStaffId,
      createdByStaffId,
      title,
      description: description ?? null,
      dueAt: dueAt ?? null,
      status: "open",
      priority: "normal",
      viaAI: viaAI ?? false,
      // Only set when there's an actual reminder id to store — the "Task"
      // table predates this column (needs migration 20260818_task_scheduler_
      // event.sql). Including the key unconditionally would break every task
      // creation, not just reminder ones, on any DB that hasn't had it applied.
      ...(schedulerEventId ? { schedulerEventId } : {}),
      createdAt: now,
      updatedAt: now,
    })
    .select()
    .single();
  if (error) throw dbErr(`creating task: ${error.message}`);
  // reminderFailed is request-response metadata, not a DB column — never
  // persisted, just handed back so the route can tell the staff member
  // their reminder genuinely didn't get set, instead of the task looking
  // identically successful either way.
  return { ...data, reminderFailed: dueAt ? reminderFailed : undefined };
}

// nettu-client's deleteEvent(userId, eventId) doesn't actually use `userId`
// for this endpoint (DELETE /api/v1/user/events/:eventId, no :userId in the
// path) — passing null is deliberate, not a bug, and avoids needing to
// resolve/store which doctor's calendar the reminder rode on just to cancel it.
async function cancelReminderIfAny(nettuClient, task, log) {
  if (!task?.schedulerEventId || !nettuClient) return;
  try {
    await nettuClient.deleteEvent(null, task.schedulerEventId);
  } catch (err) {
    log?.warn?.({ err, taskId: task.id }, "[taskSvc] failed to cancel nettu reminder");
  }
}

async function toggleTask(supabaseClient, clinicId, taskId, done, { nettuClient, log } = {}) {
  const { data, error } = await supabaseClient
    .from("Task")
    .update({ status: done ? "done" : "open", updatedAt: new Date().toISOString() })
    .eq("id", taskId)
    .eq("clinicId", clinicId)
    .select()
    .maybeSingle();
  if (error) throw dbErr(`updating task: ${error.message}`);
  if (!data) throw notFound(taskId);
  // Only cancel on completion — reopening a task doesn't need a fresh reminder.
  if (done) await cancelReminderIfAny(nettuClient, data, log);
  return data;
}

async function deleteTask(supabaseClient, clinicId, taskId, { nettuClient, log } = {}) {
  const { data: existing } = await supabaseClient
    .from("Task")
    .select("*")
    .eq("id", taskId)
    .eq("clinicId", clinicId)
    .maybeSingle();
  const { error } = await supabaseClient.from("Task").delete().eq("id", taskId).eq("clinicId", clinicId);
  if (error) throw dbErr(`deleting task: ${error.message}`);
  await cancelReminderIfAny(nettuClient, existing, log);
}

// Safety net for a due task whose nettu reminder was never set (silently
// failed at creation, or nettu itself was flaky at the moment it fired) —
// live-reported bug (2026-09-08): "due now and stuff should be properly
// handled, no missing notifications should be there." Same "computed on
// read, nothing persisted on Task itself" posture as queue-service.js's
// listPossibleNoShows, for the same reason: no new column/migration needed,
// and a task's due-ness is always freshly re-derived, never able to drift.
// Dedup goes through the Notification table itself (a `type: "reminder"`
// row whose `data.taskId` matches) rather than a new Task column — one
// extra query, same "two queries, reduce in JS" shape already used
// elsewhere in this codebase, cheaper than a schema change for a purely
// internal bookkeeping need. Uses the existing "reminder" NotifKind
// (frontend already renders it) rather than inventing a new type string —
// the frontend's notifications page indexes an icon lookup table by type
// with no runtime fallback for an unrecognized one, so a new type here
// would have crashed that page the first time one of these fired.
async function notifyDueTasks(supabaseClient, clinicId, staffId, log) {
  const now = new Date().toISOString();
  const { data: due, error } = await supabaseClient
    .from("Task")
    .select("id, title, dueAt")
    .eq("clinicId", clinicId)
    .eq("assignedStaffId", staffId)
    .eq("status", "open")
    // No explicit "dueAt is not null" filter needed — a null/absent dueAt
    // already fails a <= comparison against a real timestamp (both in
    // Postgres, where NULL compared to anything is NULL/not-true, and in
    // this codebase's test stub, where an unset column coerces to NaN).
    .lte("dueAt", now);
  if (error) throw dbErr(`checking due tasks: ${error.message}`);
  if (!due?.length) return;

  const { data: existing, error: notifErr } = await supabaseClient
    .from("Notification")
    .select("data")
    .eq("clinicId", clinicId)
    .eq("type", "reminder");
  if (notifErr) {
    log?.warn?.({ err: notifErr }, "[taskSvc] couldn't check existing task-due notifications — skipping this pass");
    return;
  }
  const alreadyNotified = new Set((existing ?? []).map((n) => n.data?.taskId).filter(Boolean));

  for (const task of due) {
    if (alreadyNotified.has(task.id)) continue;
    try {
      await notificationSvc.createNotification(supabaseClient, {
        clinicId,
        staffId,
        type: "reminder",
        title: "Task due",
        body: task.title,
        data: { taskId: task.id },
      });
      const subscriptions = await pushSvc.listSubscriptionsForStaff(supabaseClient, staffId);
      await Promise.all(
        subscriptions.map((sub) =>
          pushSvc
            .sendPush(sub, { title: "Task due", body: task.title, data: { taskId: task.id } }, log)
            .catch((err) => log?.warn?.({ err, taskId: task.id }, "[taskSvc] due-task push failed")),
        ),
      );
    } catch (err) {
      log?.warn?.({ err, taskId: task.id }, "[taskSvc] couldn't create due-task notification");
    }
  }
}

module.exports = { listTasks, createTask, toggleTask, deleteTask, notifyDueTasks };
