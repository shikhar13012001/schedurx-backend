const { Router } = require("express");
const callLogSvc = require("../services/call-log-service");

// Machine-facing write for voice-agent call records. Deliberately independent
// of callContextStore (unlike the Ultravox-specific /tools/patients etc.) —
// a future caller like schedurx-calling-agent posts clinicId/phone directly
// once a call ends, rather than needing an in-flight call context.
function createToolCallLogsRouter(supabaseClient) {
  const router = Router();

  router.post("/", async (req, res) => {
    req.log.info({ body: req.body }, "[tool] create_call_log invoked");
    const { clinicId, patientId, phone, name, lang, durationSec, outcome, summary, recordingUrl } = req.body ?? {};

    if (!clinicId || !phone) {
      return res.status(422).json({ error: "clinicId and phone are required" });
    }

    try {
      const row = await callLogSvc.createCallLog(supabaseClient, {
        clinicId,
        patientId,
        phone,
        name,
        lang,
        durationSec,
        outcome,
        summary,
        recordingUrl,
      });
      return res.status(201).json(row);
    } catch (err) {
      req.log.error({ err, clinicId, phone }, "Call log creation failed");
      return res.status(500).json({ error: "Internal server error" });
    }
  });

  return router;
}

module.exports = { createToolCallLogsRouter };
