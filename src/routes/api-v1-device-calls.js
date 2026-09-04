const { Router } = require("express");
const { fail } = require("../lib/response-envelope");
const missedCallSvc = require("../services/missed-call-service");

// POST /api/v1/device-calls — the Android companion app's report of a
// missed call read off the staff phone's own native call log. Auth is the
// same firebaseAuth every other /api/v1 route runs behind (mounted in
// api-v1.js), so clinicId/staffId are always the caller's own, never
// client-supplied.
function createApiV1DeviceCallsRouter(supabaseClient, twilioClient) {
  const router = Router();

  router.post("/", async (req, res) => {
    try {
      const { phone, deviceCallTimestamp } = req.body ?? {};
      if (!phone || deviceCallTimestamp == null) {
        return fail(res, 422, "MISSING_FIELDS", "phone and deviceCallTimestamp are required");
      }

      const result = await missedCallSvc.handleDeviceMissedCall(
        supabaseClient,
        twilioClient,
        {
          clinicId: req.staff.clinicId,
          staffId: req.staff.staffId,
          phone,
          deviceCallTimestamp: Number(deviceCallTimestamp),
        },
        req.log,
      );
      return res.status(201).json({ success: true, data: result, message: null });
    } catch (err) {
      req.log?.error({ err }, "[api-v1:device-calls] create failed");
      return fail(res, err.statusCode ?? 500, err.code ?? "INTERNAL_ERROR", err.message);
    }
  });

  return router;
}

module.exports = { createApiV1DeviceCallsRouter };
