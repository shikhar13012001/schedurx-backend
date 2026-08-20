const { makeId } = require("../lib/ids");

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
async function maybeCreateReminderEvent({ nettuClient, doctor, clinicId, taskId, staffId, dueAt, log }) {
  if (!dueAt || !nettuClient || !doctor?.schedulerDoctorId || !doctor?.schedulerCalendarId) return null;
  try {
    const event = await nettuClient.createEvent(doctor.schedulerDoctorId, {
      calendarId: doctor.schedulerCalendarId,
      startTs: new Date(dueAt).getTime(),
      durationMs: 60_000,
      busy: false,
      metadata: { clinicId, taskId, staffId, kind: "task" },
      reminders: [{ delta: 0, identifier: taskId }],
    });
    return event?.id ?? null;
  } catch (err) {
    log?.warn?.({ err, taskId }, "[taskSvc] failed to create nettu reminder — task saved without one");
    return null;
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
  const schedulerEventId = await maybeCreateReminderEvent({
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
  return data;
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

module.exports = { listTasks, createTask, toggleTask, deleteTask };
