const { fail } = require("../lib/response-envelope");

// Server-side role gate — must run after firebaseAuth (reads req.staff.role).
// The frontend's client-side checks (e.g. `settings.billing`, `role === "doctor"`)
// are UX only; this is the enforcement point the earlier gap analysis flagged
// as missing ("all of these must be re-enforced as middleware on the API routes").
function requireRole(...allowedRoles) {
  return function requireRoleMiddleware(req, res, next) {
    if (!req.staff) {
      return fail(res, 401, "UNAUTHORIZED", "Missing authenticated staff context");
    }
    if (!allowedRoles.includes(req.staff.role)) {
      return fail(res, 403, "FORBIDDEN", `Role '${req.staff.role}' cannot perform this action`);
    }
    next();
  };
}

module.exports = { requireRole };
