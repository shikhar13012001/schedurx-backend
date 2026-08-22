// Bootstrap-only endpoint: creates a brand-new Clinic, its first Doctor,
// provisions nettu-scheduler calendars for that doctor, and creates the owner
// Staff row (setting Firebase custom claims), all in one call. Unlike
// /internal/staff (which only attaches Staff to an *existing* clinicId), this
// is the only place a new Clinic row gets created — mounted behind the same
// bearerAuth(INTERNAL_API_KEY) guard, never called by the browser directly.
// The frontend's server-side /api/onboarding route handler is the one caller.

const { Router } = require("express");
const { ok, fail } = require("../lib/response-envelope");
const clinicSvc = require("../services/clinic-service");
const doctorSvc = require("../services/doctor-service");
const calendarSvc = require("../services/calendar-service");
const staffSvc = require("../services/staff-service");

// Any clinic the E2E suite creates is named with this prefix — DELETE below
// refuses to touch anything else, so a bug in a test (or a leaked
// INTERNAL_API_KEY) can never purge a real clinic's data, only ones
// self-identified as disposable test fixtures.
const TEST_CLINIC_NAME_PREFIX = "[E2E]";

function createInternalClinicOnboardingRouter(supabaseClient, nettuClient, firebaseAdminApp) {
  const router = Router();

  router.post("/", async (req, res) => {
    const {
      firebaseUid,
      email,
      phone,
      fullName,
      clinicName,
      practiceType,
      // The person completing this screen — "doctor" gets a Doctor row
      // created for them (as always), "receptionist" does not. Previously
      // this route unconditionally created a Doctor row even for a
      // receptionist founding a Solo workspace with no doctor yet — a real
      // bug the onboarding rewrite's zero-doctor Solo case depends on being
      // fixed (see staff-invite-service.js's solo-doctor-limit check, which
      // counts real Doctor rows).
      founderRole,
      timezone,
      workingDays,
      openingHour,
      closingHour,
      doctor,
    } = req.body ?? {};

    if (!firebaseUid || !clinicName) {
      return fail(res, 422, "MISSING_FIELDS", "firebaseUid and clinicName are required");
    }
    if (practiceType && !["solo", "polyclinic"].includes(practiceType)) {
      return fail(res, 422, "INVALID_PRACTICE_TYPE", "practiceType must be 'solo' or 'polyclinic'");
    }
    const resolvedFounderRole = founderRole === "receptionist" ? "receptionist" : "doctor";

    try {
      const clinic = await clinicSvc.createClinic(supabaseClient, {
        name: clinicName,
        phone,
        timezone,
        workingDays,
        openingHour,
        closingHour,
        practiceType,
      });

      let newDoctor = null;
      if (resolvedFounderRole === "doctor") {
        newDoctor = await doctorSvc.createDoctor(supabaseClient, {
          clinicId: clinic.id,
          fullName: doctor?.fullName ?? fullName,
          specialty: doctor?.specialty,
          qualification: doctor?.qualification,
          feeInr: doctor?.feeInr,
          languages: doctor?.languages,
        });

        // Provision the nettu-scheduler service + this doctor's calendar. A
        // failure here shouldn't strand the newly created Clinic/Doctor rows —
        // log and continue; the calendar can be provisioned later by
        // re-running scripts/setup-clinic-calendars.js-style logic.
        try {
          await calendarSvc.getOrCreateClinicService(nettuClient, supabaseClient, clinic.id, req.log);
          await calendarSvc.getOrCreateDoctorCalendar(nettuClient, supabaseClient, newDoctor.id, clinic.id, req.log);
        } catch (err) {
          req.log?.error({ err, clinicId: clinic.id }, "[internalClinicOnboarding] nettu calendar setup failed");
        }
      } else {
        // Still provision the clinic's own nettu-scheduler service so a
        // doctor invited later doesn't need a separate first-time setup
        // path — only the per-doctor calendar is deferred to their accept.
        try {
          await calendarSvc.getOrCreateClinicService(nettuClient, supabaseClient, clinic.id, req.log);
        } catch (err) {
          req.log?.error({ err, clinicId: clinic.id }, "[internalClinicOnboarding] nettu clinic service setup failed");
        }
      }

      const staff = await staffSvc.createStaff(supabaseClient, {
        clinicId: clinic.id,
        doctorId: newDoctor?.id ?? null,
        firebaseUid,
        email,
        phone,
        fullName,
        role: "owner",
      });

      await firebaseAdminApp.setCustomUserClaims(firebaseUid, {
        role: staff.role,
        clinicId: staff.clinicId,
        doctorId: staff.doctorId ?? null,
        fullName: staff.fullName ?? null,
      });

      return ok(
        res,
        { clinic, doctor: newDoctor, staff },
        "Clinic onboarded — claims will apply on the account's next token refresh",
      );
    } catch (err) {
      req.log?.error({ err }, "[internalClinicOnboarding] failed");
      return fail(res, err.statusCode ?? 500, err.code ?? "INTERNAL_ERROR", err.message);
    }
  });

  // E2E test cleanup only. Staff.firebaseUid is 1:1 (getStaffByFirebaseUid
  // uses .maybeSingle(), which errors if it ever isn't) — so before creating
  // a fresh test clinic for the one fixed test uid, the suite looks up
  // whatever clinic it's currently attached to (if a previous run crashed
  // before its own cleanup ran) and purges that first. Without this, a
  // second Staff row for the same uid would break /api/v1/me for every
  // subsequent test, not just leave an extra clinic lying around.
  router.get("/by-firebase-uid/:uid", async (req, res) => {
    try {
      const staff = await staffSvc.getStaffByFirebaseUid(supabaseClient, req.params.uid);
      return ok(res, { clinicId: staff?.clinicId ?? null });
    } catch (err) {
      req.log?.error({ err }, "[internalClinicOnboarding] by-firebase-uid lookup failed");
      return fail(res, err.statusCode ?? 500, err.code ?? "INTERNAL_ERROR", err.message);
    }
  });

  // E2E test cleanup only. Deliberately not a general clinic-deletion
  // endpoint — no such thing exists anywhere in this product, on purpose —
  // this only ever purges clinics the E2E suite itself created and named
  // with TEST_CLINIC_NAME_PREFIX.
  router.delete("/:id", async (req, res) => {
    try {
      const clinic = await clinicSvc.getClinic(supabaseClient, req.params.id);
      if (!clinic) return ok(res, { deleted: false, reason: "not found" });
      if (!clinic.name?.startsWith(TEST_CLINIC_NAME_PREFIX)) {
        return fail(res, 403, "NOT_A_TEST_CLINIC", `Refusing to delete a clinic not named with the ${TEST_CLINIC_NAME_PREFIX} prefix`);
      }
      const { errors } = await clinicSvc.purgeClinic(supabaseClient, req.params.id);
      if (errors.length) req.log?.warn({ clinicId: req.params.id, errors }, "[internalClinicOnboarding] purge had partial failures");
      return ok(res, { deleted: true, errors });
    } catch (err) {
      req.log?.error({ err }, "[internalClinicOnboarding] purge failed");
      return fail(res, err.statusCode ?? 500, err.code ?? "INTERNAL_ERROR", err.message);
    }
  });

  return router;
}

module.exports = { createInternalClinicOnboardingRouter };
