const { Router } = require("express");
const { createPatientsRouter } = require("./patients");
const { createDoctorsRouter } = require("./doctors");
const { createAppointmentsRouter } = require("./appointments");
const { createCalendarToolsRouter } = require("./calendar-tools");
const { createToolCallLogsRouter } = require("./tool-call-logs");
const callContextStore = require("../stores/call-context-store");

// Ultravox bakes clinicId/phoneNumber into every tool call as static body
// parameters (set once, at call-creation time, by the demo bridge — see
// schedurx-ultravox-demo-api's ultravox-tools.js). This middleware seeds those
// into the call-context store before any tool route runs, so the rest of the
// tool routes only ever need to read from callStore keyed by ultravoxCallId,
// exactly like they did when everything lived in one process.
function seedCallContext(req, res, next) {
  const { ultravoxCallId, clinicId, phoneNumber } = req.body ?? {};
  if (ultravoxCallId && (clinicId || phoneNumber)) {
    callContextStore.upsert(ultravoxCallId, {
      ...(clinicId ? { clinicId } : {}),
      ...(phoneNumber ? { phoneNumber } : {}),
    });
  }
  next();
}

function createToolsRouter(supabaseClient, nettuClient, twilioClient) {
  const router = Router();

  router.use(seedCallContext);

  router.use("/patients", createPatientsRouter(supabaseClient, callContextStore));
  router.use("/doctors", createDoctorsRouter(supabaseClient, callContextStore));
  router.use("/appointments", createAppointmentsRouter(nettuClient, supabaseClient, callContextStore, twilioClient));
  router.use("/call-logs", createToolCallLogsRouter(supabaseClient));

  // Calendar-integrated tools — only mounted when nettuClient is available.
  if (nettuClient) {
    router.use("/calendar", createCalendarToolsRouter(nettuClient, supabaseClient, callContextStore, twilioClient));
  }

  return router;
}

module.exports = { createToolsRouter };
