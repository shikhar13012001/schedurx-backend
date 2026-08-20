// GET /api/v1/realtime-token — mints a short-lived Supabase-compatible JWT
// (signed with SUPABASE_JWT_SECRET) carrying { clinicId, role } claims, for the
// browser to open a Supabase Realtime subscription on QueueItem under RLS
// (see supabase/migrations/20260803_queue_item.sql's policy). Returns 501 when
// SUPABASE_JWT_SECRET isn't configured — the dashboard is expected to fall back
// to polling GET /api/v1/queue in that case, so this is a progressive
// enhancement, not a hard dependency.

const { Router } = require("express");
const jwt = require("jsonwebtoken");
const { ok, fail } = require("../lib/response-envelope");
const { config } = require("../config");

const TOKEN_TTL_SECONDS = 60 * 60;

function createApiV1RealtimeTokenRouter() {
  const router = Router();

  router.get("/", (req, res) => {
    if (!config.SUPABASE_JWT_SECRET) {
      return fail(
        res,
        501,
        "REALTIME_NOT_CONFIGURED",
        "SUPABASE_JWT_SECRET is not set — poll GET /api/v1/queue instead",
      );
    }

    const token = jwt.sign(
      {
        role: "authenticated",
        clinicId: req.staff.clinicId,
        staffRole: req.staff.role,
      },
      config.SUPABASE_JWT_SECRET,
      { expiresIn: TOKEN_TTL_SECONDS },
    );

    return ok(res, { token, expiresInSeconds: TOKEN_TTL_SECONDS });
  });

  return router;
}

module.exports = { createApiV1RealtimeTokenRouter };
