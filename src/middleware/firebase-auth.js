const { fail } = require("../lib/response-envelope");
const staffSvc = require("../services/staff-service");

// Verifies a Firebase ID token and attaches req.staff = { uid, staffId, email,
// fullName, role, clinicId, doctorId }, sourced from Firebase custom claims
// set at staff onboarding time (see routes/internal-staff-onboarding.js).
// Every /api/v1/* route trusts req.staff.clinicId — clinicId must never be
// read from a query param or request body for these routes.
//
// `uid` is the Firebase UID (opaque to Postgres); `staffId` is the actual
// Staff.id every staffId-family foreign key (Task.assignedStaffId,
// Notification.staffId, ChatMsg.senderStaffId, PushSubscription.staffId)
// points at — conflating the two throws a foreign key violation on write and
// silently returns nothing on read, so routes must use staffId for those,
// never uid. Resolved via one extra lookup per request rather than baking it
// into the JWT claims, so it doesn't depend on every existing session
// refreshing its token after onboarding.
//
// Mirrors middleware/bearer-auth.js's factory shape, but the /api/v1 surface
// uses the structured { success, error } envelope rather than bearer-auth's
// bare { error } shape, since /api/v1 is the newer, REST-conventioned surface.
function firebaseAuth(firebaseAdminApp, supabaseClient) {
  return async function firebaseAuthMiddleware(req, res, next) {
    const header = req.headers.authorization ?? "";
    const [scheme, token] = header.split(" ");

    if (scheme !== "Bearer" || !token) {
      return fail(res, 401, "UNAUTHORIZED", "Missing or malformed Authorization header");
    }

    let decoded;
    try {
      decoded = await firebaseAdminApp.verifyIdToken(token);
    } catch (err) {
      req.log?.warn({ err }, "[firebaseAuth] token verification failed");
      return fail(res, 401, "UNAUTHORIZED", "Invalid or expired token");
    }

    if (!decoded.clinicId || !decoded.role) {
      return fail(
        res,
        403,
        "STAFF_NOT_ONBOARDED",
        "This account has no clinic/role assigned yet — contact your clinic owner",
      );
    }

    const staffRow = await staffSvc.getStaffByFirebaseUid(supabaseClient, decoded.uid);
    if (!staffRow) {
      return fail(res, 403, "STAFF_NOT_ONBOARDED", "No Staff record found for this account");
    }

    req.staff = {
      uid: decoded.uid,
      staffId: staffRow.id,
      email: decoded.email ?? null,
      fullName: decoded.fullName ?? null,
      role: decoded.role,
      clinicId: decoded.clinicId,
      doctorId: decoded.doctorId ?? null,
    };

    next();
  };
}

module.exports = { firebaseAuth };
