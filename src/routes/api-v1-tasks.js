const { Router } = require("express");
const { ok, fail } = require("../lib/response-envelope");
const taskSvc = require("../services/task-service");
const tableSvc = require("../services/table-service");

// Resolves which doctor's nettu calendar a task's reminder (if it gets one)
// rides on — the requester's own doctor if they have one, else the clinic's
// first active doctor, matching the fallback convention used everywhere else
// in this app (home page, block-time, the assistant's system prompt).
async function resolveReminderDoctor(supabaseClient, staff) {
  const doctors = await tableSvc.listActiveDoctors(supabaseClient, staff.clinicId);
  return doctors.find((d) => d.id === staff.doctorId) ?? doctors[0] ?? null;
}

function createApiV1TasksRouter(supabaseClient, nettuClient) {
  const router = Router();

  router.get("/", async (req, res) => {
    try {
      const tasks = await taskSvc.listTasks(supabaseClient, req.staff.clinicId, req.staff.staffId);
      return ok(res, { tasks });
    } catch (err) {
      req.log?.error({ err }, "[api-v1:tasks] list failed");
      return fail(res, err.statusCode ?? 500, err.code ?? "INTERNAL_ERROR", err.message);
    }
  });

  router.post("/", async (req, res) => {
    try {
      const doctor = req.body?.dueAt ? await resolveReminderDoctor(supabaseClient, req.staff) : null;
      const task = await taskSvc.createTask(supabaseClient, {
        ...req.body,
        clinicId: req.staff.clinicId,
        createdByStaffId: req.staff.staffId,
        nettuClient,
        doctor,
        log: req.log,
      });
      return res.status(201).json({ success: true, data: { task }, message: null });
    } catch (err) {
      req.log?.error({ err }, "[api-v1:tasks] create failed");
      return fail(res, err.statusCode ?? 500, err.code ?? "INTERNAL_ERROR", err.message);
    }
  });

  router.patch("/:id", async (req, res) => {
    try {
      const task = await taskSvc.toggleTask(supabaseClient, req.staff.clinicId, req.params.id, req.body?.done, {
        nettuClient,
        log: req.log,
      });
      return ok(res, { task });
    } catch (err) {
      req.log?.error({ err }, "[api-v1:tasks] update failed");
      return fail(res, err.statusCode ?? 500, err.code ?? "INTERNAL_ERROR", err.message);
    }
  });

  router.delete("/:id", async (req, res) => {
    try {
      await taskSvc.deleteTask(supabaseClient, req.staff.clinicId, req.params.id, { nettuClient, log: req.log });
      return res.status(204).send();
    } catch (err) {
      req.log?.error({ err }, "[api-v1:tasks] delete failed");
      return fail(res, err.statusCode ?? 500, err.code ?? "INTERNAL_ERROR", err.message);
    }
  });

  return router;
}

module.exports = { createApiV1TasksRouter };
