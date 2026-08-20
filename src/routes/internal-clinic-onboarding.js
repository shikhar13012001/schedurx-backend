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

function createInternalClinicOnboardingRouter(supabaseClient, nettuClient, firebaseAdminApp) {
  const router = Router();

  router.post("/", async (req, res) => {
    const { firebaseUid, email, phone, fullName, clinicName, timezone, workingDays, openingHour, closingHour, doctor } =
      req.body ?? {};

    if (!firebaseUid || !clinicName) {
      return fail(res, 422, "MISSING_FIELDS", "firebaseUid and clinicName are required");
    }

    try {
      const clinic = await clinicSvc.createClinic(supabaseClient, {
        name: clinicName,
        phone,
        timezone,
        workingDays,
        openingHour,
        closingHour,
      });

      const newDoctor = await doctorSvc.createDoctor(supabaseClient, {
        clinicId: clinic.id,
        fullName: doctor?.fullName ?? fullName,
        specialty: doctor?.specialty,
        qualification: doctor?.qualification,
        feeInr: doctor?.feeInr,
        languages: doctor?.languages,
      });

      // Provision the nettu-scheduler service + this doctor's calendar. A
      // failure here shouldn't strand the newly created Clinic/Doctor rows —
      // log and continue; the calendar can be provisioned later by re-running
      // scripts/setup-clinic-calendars.js-style logic for this clinic.
      try {
        await calendarSvc.getOrCreateClinicService(nettuClient, supabaseClient, clinic.id, req.log);
        await calendarSvc.getOrCreateDoctorCalendar(nettuClient, supabaseClient, newDoctor.id, clinic.id, req.log);
      } catch (err) {
        req.log?.error({ err, clinicId: clinic.id }, "[internalClinicOnboarding] nettu calendar setup failed");
      }

      const staff = await staffSvc.createStaff(supabaseClient, {
        clinicId: clinic.id,
        doctorId: newDoctor.id,
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

  return router;
}

module.exports = { createInternalClinicOnboardingRouter };
