// The resumable onboarding flow's authenticated surface (screens 3-7 — "You"
// through "Team"). Screens 1-2 (Google auth, practice type + clinic name)
// still go through the pre-auth bootstrap at /internal/clinic, since no
// Staff/session exists yet at that point — see internal-clinic-onboarding.js.
//
// Every route here reads/writes only req.staff's own clinic/doctor/staff
// rows (firebaseAuth already attached req.staff) — there is no clinicId in
// any request body, matching every other authenticated route in this app.

const { Router } = require("express");
const { ok, fail } = require("../lib/response-envelope");
const { requireRole } = require("../middleware/require-role");
const clinicSvc = require("../services/clinic-service");
const doctorSvc = require("../services/doctor-service");
const staffSvc = require("../services/staff-service");
const phoneRouteSvc = require("../services/phone-route-service");
const { normalizeIndianMobile } = require("../lib/phone");
const { PLANS, ADDONS, CREDIT_PACKS } = require("../lib/plans");
const callForwardingLib = require("../lib/call-forwarding");

function createApiV1OnboardingRouter(supabaseClient) {
  const router = Router();

  // Hydrates the wizard on load/resume: clinic-level state + the caller's
  // own staff/doctor state, plus the static plan/call-forwarding catalogs so
  // the frontend never hard-codes pricing or dial-code copy itself.
  router.get("/", async (req, res) => {
    try {
      const [clinic, staff, doctor] = await Promise.all([
        clinicSvc.getClinic(supabaseClient, req.staff.clinicId),
        staffSvc.getStaffById(supabaseClient, req.staff.staffId),
        req.staff.doctorId ? doctorSvc.getDoctor(supabaseClient, req.staff.doctorId) : Promise.resolve(null),
      ]);
      return ok(res, {
        clinic,
        staff,
        doctor,
        catalog: {
          plans: PLANS,
          addons: ADDONS,
          creditPacks: CREDIT_PACKS,
          carriers: callForwardingLib.CARRIERS,
          forwardingNumber: callForwardingLib.forwardingNumber(),
        },
      });
    } catch (err) {
      req.log?.error({ err }, "[api-v1:onboarding] state fetch failed");
      return fail(res, err.statusCode ?? 500, err.code ?? "INTERNAL_ERROR", err.message);
    }
  });

  // "You" — the caller's own personal/professional profile. Doctors write
  // the rich profile onto their Doctor row; every role also keeps Staff's
  // own fullName/phone in sync (that's what session/display reads).
  router.patch("/profile", async (req, res) => {
    try {
      const body = req.body ?? {};
      if (body.personalPhone) {
        const normalized = normalizeIndianMobile(body.personalPhone);
        if (!normalized) return fail(res, 422, "INVALID_PHONE", "Use a 10-digit Indian mobile number");
        body.personalPhone = normalized;
      }

      const staffPatch = {};
      if ("fullName" in body) staffPatch.fullName = body.fullName;
      if (body.personalPhone) staffPatch.phone = body.personalPhone;
      if ("workingDaysOverride" in body) staffPatch.workingDaysOverride = body.workingDaysOverride;
      if ("workingHoursStart" in body) staffPatch.workingHoursStart = body.workingHoursStart;
      if ("workingHoursEnd" in body) staffPatch.workingHoursEnd = body.workingHoursEnd;
      if ("breaks" in body) staffPatch.breaks = body.breaks;

      let staff = null;
      if (Object.keys(staffPatch).length) {
        staff = await staffSvc.updateStaffOnboardingProfile(supabaseClient, req.staff.staffId, staffPatch);
      }

      let doctor = null;
      if (req.staff.doctorId) {
        doctor = await doctorSvc.updateDoctorOnboardingProfile(supabaseClient, req.staff.doctorId, body);
      }

      return ok(res, { staff, doctor });
    } catch (err) {
      req.log?.error({ err }, "[api-v1:onboarding] profile update failed");
      return fail(res, err.statusCode ?? 500, err.code ?? "INTERNAL_ERROR", err.message);
    }
  });

  // Advances the caller's own personal onboarding step ("you" -> "hours" ->
  // "completed") — every role calls this, independent of the clinic-level
  // step below.
  router.patch("/staff-step", async (req, res) => {
    const { step } = req.body ?? {};
    try {
      await staffSvc.advanceStaffOnboardingStep(supabaseClient, req.staff.staffId, step);
      return ok(res, { onboardingStep: step });
    } catch (err) {
      return fail(res, err.statusCode ?? 500, err.code ?? "INTERNAL_ERROR", err.message);
    }
  });

  // "Clinic" — org identity/address/appointment defaults/hours. Owner only:
  // an invited doctor/receptionist inherits this, they don't reconfigure it.
  router.patch("/clinic", requireRole("owner"), async (req, res) => {
    try {
      const body = { ...(req.body ?? {}) };
      if (body.phone) {
        const normalized = normalizeIndianMobile(body.phone);
        if (!normalized) return fail(res, 422, "INVALID_PHONE", "Use a 10-digit Indian mobile number");
        body.phone = normalized;
      }
      if (body.pincode && !/^\d{6}$/.test(body.pincode)) {
        return fail(res, 422, "INVALID_PINCODE", "PIN code must be 6 digits");
      }
      const clinic = await clinicSvc.updateClinicProfile(supabaseClient, req.staff.clinicId, body);
      return ok(res, { clinic });
    } catch (err) {
      req.log?.error({ err }, "[api-v1:onboarding] clinic update failed");
      return fail(res, err.statusCode ?? 500, err.code ?? "INTERNAL_ERROR", err.message);
    }
  });

  // "Plan" — persisted selection only (see lib/plans.js's header comment —
  // no real subscription/payment exists yet). Owner only.
  router.patch("/plan", requireRole("owner"), async (req, res) => {
    try {
      const plan = await clinicSvc.updateClinicPlan(supabaseClient, req.staff.clinicId, req.body ?? {});
      return ok(res, { plan });
    } catch (err) {
      return fail(res, err.statusCode ?? 500, err.code ?? "INTERNAL_ERROR", err.message);
    }
  });

  // "Calls" — owner only. When a real reception number + carrier are given,
  // this also registers/updates a real PhoneNumberRoute pointing at the
  // shared forwarding number, so a genuinely forwarded call already
  // resolves to this clinic the first time it happens — not just a status
  // flag with nothing behind it.
  router.patch("/call-forwarding", requireRole("owner"), async (req, res) => {
    try {
      const { carrier, status, receptionNumber } = req.body ?? {};
      if (carrier && !["jio", "airtel", "other"].includes(carrier)) {
        return fail(res, 422, "INVALID_CARRIER", "carrier must be 'jio', 'airtel', or 'other'");
      }

      const callForwarding = await clinicSvc.updateClinicCallForwarding(supabaseClient, req.staff.clinicId, {
        carrier,
        status,
      });

      let dialCode = null;
      if (carrier === "jio" || carrier === "airtel") dialCode = callForwardingLib.buildDialCode(carrier);

      if (receptionNumber) {
        const normalized = normalizeIndianMobile(receptionNumber);
        if (!normalized) return fail(res, 422, "INVALID_PHONE", "Use a 10-digit Indian mobile number");
        const forwardingNumber = callForwardingLib.forwardingNumber();
        if (forwardingNumber) {
          const existing = await phoneRouteSvc.listPhoneRoutes(supabaseClient, req.staff.clinicId);
          const defaultRoute = existing.find((r) => !r.doctorId);
          if (defaultRoute) {
            await phoneRouteSvc.updatePhoneRoute(supabaseClient, req.staff.clinicId, defaultRoute.id, {
              originalNumber: normalized,
              twilioNumber: forwardingNumber,
            });
          } else {
            await phoneRouteSvc.createPhoneRoute(supabaseClient, {
              clinicId: req.staff.clinicId,
              originalNumber: normalized,
              twilioNumber: forwardingNumber,
            });
          }
        }
      }

      return ok(res, { callForwarding, dialCode });
    } catch (err) {
      req.log?.error({ err }, "[api-v1:onboarding] call-forwarding update failed");
      return fail(res, err.statusCode ?? 500, err.code ?? "INTERNAL_ERROR", err.message);
    }
  });

  // Advances the clinic-level step ("clinic" -> "plan" -> "calls" -> "team"
  // -> "completed"). Owner only — this is the org-level sequence, not any
  // individual staff member's own progress.
  router.patch("/clinic-step", requireRole("owner"), async (req, res) => {
    const { step } = req.body ?? {};
    try {
      await clinicSvc.advanceClinicOnboardingStep(supabaseClient, req.staff.clinicId, step);
      return ok(res, { onboardingStep: step });
    } catch (err) {
      return fail(res, err.statusCode ?? 500, err.code ?? "INTERNAL_ERROR", err.message);
    }
  });

  // Final action on screen 7 ("Go to ScheduRx") and on an invited user's
  // shortened flow. Always completes the caller's own Staff onboarding;
  // additionally completes the clinic's org-level onboarding when the
  // caller is the owner, so a receptionist/doctor finishing their own short
  // flow never accidentally marks org-level setup done on the owner's
  // behalf.
  router.post("/complete", async (req, res) => {
    try {
      const staff = await staffSvc.completeStaffOnboarding(supabaseClient, req.staff.staffId);
      let clinic = null;
      if (req.staff.role === "owner") {
        clinic = await clinicSvc.completeClinicOnboarding(supabaseClient, req.staff.clinicId);
      }
      return ok(res, { staff, clinic });
    } catch (err) {
      req.log?.error({ err }, "[api-v1:onboarding] complete failed");
      return fail(res, err.statusCode ?? 500, err.code ?? "INTERNAL_ERROR", err.message);
    }
  });

  return router;
}

module.exports = { createApiV1OnboardingRouter };
