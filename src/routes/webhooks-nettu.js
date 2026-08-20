// Receives reminder callbacks from nettu-scheduler (see scripts/setup-nettu-webhook.js
// for the one-time registration). nettu calls this REMINDER_MINUTES_BEFORE
// minutes (appointment-service.js) before each event it was told to remind
// on, with the full CalendarEvent — including the metadata we stamped onto
// it at booking time (clinicId, appointmentId, doctorId, kind).
//
// Turns each reminder into a clinic-wide Notification, which the dashboard
// already polls for (GET /api/v1/notifications) — no separate delivery
// mechanism needed on top of what's already built.

const { Router } = require("express");
const notificationSvc = require("../services/notification-service");
const commsWorkflowSvc = require("../services/comms-workflow-service");
const pushSvc = require("../services/push-service");

// Best-effort push alongside the in-app Notification that was just created —
// never blocks or fails the reminder flow it's attached to (sendPush itself
// already no-ops quietly when VAPID isn't configured). staffId present means
// a personal reminder (push that one person); absent means the clinic-wide
// broadcast notification-service.js already fans out to everyone.
async function pushAlongside(supabaseClient, { clinicId, staffId, title, body, data }, log) {
  try {
    const subscriptions = staffId
      ? await pushSvc.listSubscriptionsForStaff(supabaseClient, staffId)
      : await pushSvc.listSubscriptionsForClinic(supabaseClient, clinicId);
    await Promise.all(
      subscriptions.map((sub) =>
        pushSvc.sendPush(sub, { title, body, data }, log).catch((err) => log?.warn({ err }, "[webhooks:nettu] push failed")),
      ),
    );
  } catch (err) {
    log?.warn({ err }, "[webhooks:nettu] push lookup failed");
  }
}

function createNettuWebhookRouter(supabaseClient, webhookKey, twilioClient) {
  const router = Router();

  router.post("/", async (req, res) => {
    if (req.headers["nettu-scheduler-webhook-key"] !== webhookKey) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    const reminders = Array.isArray(req.body?.reminders) ? req.body.reminders : [];
    req.log?.info({ count: reminders.length }, "[webhooks:nettu] reminders received");

    for (const reminder of reminders) {
      const metadata = reminder?.event?.metadata ?? {};
      const { clinicId, appointmentId, doctorId, taskId, staffId, kind } = metadata;
      if (!clinicId) {
        req.log?.warn({ reminder }, "[webhooks:nettu] reminder missing clinicId in metadata — skipped");
        continue;
      }

      // Task reminders are personal (one staff member's to-do), not a
      // clinic-wide broadcast like appointment/blocked-time reminders below —
      // they're a separate branch rather than reusing the shared doctor/
      // appointment lookups those need.
      if (kind === "task") {
        try {
          const { data: task } = taskId
            ? await supabaseClient.from("Task").select("title").eq("id", taskId).maybeSingle()
            : { data: null };
          const title = "Task due";
          const body = task?.title ?? "A task is due now.";
          await notificationSvc.createNotification(supabaseClient, {
            clinicId,
            staffId: staffId ?? null,
            type: "reminder",
            title,
            body,
            data: { taskId, kind: "task" },
          });
          await pushAlongside(supabaseClient, { clinicId, staffId, title, body, data: { taskId } }, req.log);
        } catch (err) {
          req.log?.error({ err, reminder }, "[webhooks:nettu] failed to create notification for task reminder");
        }
        continue;
      }

      // A patient-facing comms workflow reminder — identifier is
      // "<appointmentId>::<workflowId>" (see comms-workflow-service.js),
      // distinct from the plain-appointmentId identifier the staff -15min
      // reminder below uses. Handled entirely separately so adding workflow
      // reminders never also spams an extra staff Notification for the same
      // appointment.
      const identifier = reminder?.identifier ?? "";
      const workflowId = identifier.includes("::") ? identifier.split("::")[1] : null;
      if (workflowId) {
        try {
          await commsWorkflowSvc.sendDelayedWorkflowMessage(
            { supabaseClient, twilioClient, clinicId, appointmentId, workflowId },
            req.log,
          );
        } catch (err) {
          req.log?.error({ err, reminder }, "[webhooks:nettu] failed to send workflow reminder");
        }
        continue;
      }

      try {
        const [{ data: doctor }, { data: appointment }] = await Promise.all([
          doctorId ? supabaseClient.from("Doctor").select("fullName").eq("id", doctorId).maybeSingle() : { data: null },
          appointmentId
            ? supabaseClient.from("Appointment").select("patientId, symptoms").eq("id", appointmentId).maybeSingle()
            : { data: null },
        ]);

        let patientName = null;
        if (appointment?.patientId) {
          const { data: patient } = await supabaseClient
            .from("Patient")
            .select("fullName")
            .eq("id", appointment.patientId)
            .maybeSingle();
          patientName = patient?.fullName ?? null;
        }

        const doctorName = doctor?.fullName ?? "A doctor";
        const isBlocked = kind === "blocked";
        const title = isBlocked ? "Blocked time starting soon" : "Appointment starting soon";
        const body = isBlocked
          ? `${doctorName}'s blocked time starts in a few minutes.`
          : `${doctorName}'s appointment${patientName ? ` with ${patientName}` : ""} starts in a few minutes.`;

        await notificationSvc.createNotification(supabaseClient, {
          clinicId,
          staffId: null, // clinic-wide broadcast — reminders aren't tied to one staff login
          type: "reminder",
          title,
          body,
          data: { appointmentId, doctorId, kind: kind ?? "appointment" },
        });
        await pushAlongside(supabaseClient, { clinicId, staffId: null, title, body, data: { appointmentId } }, req.log);
      } catch (err) {
        // One bad reminder shouldn't drop the rest of the batch.
        req.log?.error({ err, reminder }, "[webhooks:nettu] failed to create notification for reminder");
      }
    }

    res.status(200).json({ received: true });
  });

  return router;
}

module.exports = { createNettuWebhookRouter };
