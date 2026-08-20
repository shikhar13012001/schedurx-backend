// Wraps nettu-scheduler API calls for clinic and doctor calendar lifecycle.
// Idempotent: checks DB for existing IDs before creating new resources.

const clinicSvc = require("./clinic-service");
const doctorSvc = require("./doctor-service");

// Convert "09:00" → { hours: 9, minutes: 0 }
function parseTime(hhmm) {
  const [h, m] = hhmm.split(":").map(Number);
  return { hours: h, minutes: m ?? 0 };
}

// Build nettu schedule rules from effective doctor scheduling rules.
//
// ScheduleRuleVariant is a tagged enum { type: "WDay", value: "Mon" } — one rule per weekday.
// Attempting to put multiple weekdays in a single rule is invalid (server returns 400).
function buildScheduleRules(doctorRules) {
  const interval = {
    start: parseTime(doctorRules.workingHoursStart),
    end: parseTime(doctorRules.workingHoursEnd),
  };

  return doctorRules.workingDays.map((day) => ({
    variant: { type: "WDay", value: day },
    intervals: [interval],
  }));
}

// Resolve a doctor's existing schedule through the clinic service membership.
// Returns the schedule object or null if the doctor is not yet a service member.
async function findExistingSchedule(nettuClient, serviceId, nettuUserId) {
  if (!serviceId) return null;
  const service = await nettuClient.getService(serviceId);
  const member = service?.users?.find((u) => u.userId === nettuUserId);
  if (!member?.availability?.id) return null;
  return nettuClient.getSchedule(member.availability.id);
}

// ─── Clinic service ───────────────────────────────────────────────────────────

async function getOrCreateClinicService(nettuClient, supabaseClient, clinicId, log) {
  const clinic = await clinicSvc.requireActiveClinic(supabaseClient, clinicId);
  const clinicRules = clinicSvc.getSchedulingRules(clinic);

  if (clinic.schedulerServiceId) {
    const existing = await nettuClient.getService(clinic.schedulerServiceId);
    if (existing) {
      log?.debug({ clinicId, serviceId: existing.id }, "[calendarSvc] existing nettu service found");
      return { service: existing, isNew: false };
    }
    log?.warn(
      { clinicId, schedulerServiceId: clinic.schedulerServiceId },
      "[calendarSvc] stored service ID not found in nettu — recreating",
    );
  }

  const service = await nettuClient.createService({ clinicId });

  await clinicSvc.saveSchedulerIds(supabaseClient, clinicId, {
    schedulerServiceId: service.id,
    schedulerCalendarId: null,
  });

  log?.info({ clinicId, serviceId: service.id }, "[calendarSvc] created nettu service for clinic");
  return { service, isNew: true };
}

// ─── Doctor calendar ──────────────────────────────────────────────────────────

async function getOrCreateDoctorCalendar(nettuClient, supabaseClient, doctorId, clinicId, log) {
  const doctor = await doctorSvc.requireActiveDoctor(supabaseClient, doctorId, clinicId);
  const clinic = await clinicSvc.requireActiveClinic(supabaseClient, clinicId);
  const clinicRules = clinicSvc.getSchedulingRules(clinic);
  const doctorRules = doctorSvc.getSchedulingRules(doctor, clinicRules);
  const timezone = doctorRules.timezone;

  let nettuUser = null;
  let calendar = null;
  let isNew = false;

  if (doctor.schedulerDoctorId) {
    nettuUser = await nettuClient.getUser(doctor.schedulerDoctorId);
  }

  if (!nettuUser) {
    nettuUser = await nettuClient.createUser({ doctorId, clinicId });
    isNew = true;
    log?.info({ doctorId, nettuUserId: nettuUser.id }, "[calendarSvc] created nettu user for doctor");
  }

  if (doctor.schedulerCalendarId) {
    calendar = await nettuClient.getCalendar(nettuUser.id, doctor.schedulerCalendarId);
  }

  if (!calendar) {
    calendar = await nettuClient.createCalendar(nettuUser.id, {
      timezone,
      metadata: { doctorId, clinicId },
    });
    log?.info({ doctorId, calendarId: calendar.id }, "[calendarSvc] created nettu calendar for doctor");
  }

  // Create or reuse schedule (one rule per weekday — nettu does not accept multi-weekday rules).
  // nettu has no "list schedules for user" endpoint, so an existing schedule is
  // resolved through the clinic service membership (availability.id).
  let schedule = await findExistingSchedule(nettuClient, clinic.schedulerServiceId, nettuUser.id);

  if (schedule) {
    log?.debug({ doctorId, scheduleId: schedule.id }, "[calendarSvc] existing schedule found");
  } else {
    schedule = await nettuClient.createSchedule(nettuUser.id, {
      timezone,
      rules: buildScheduleRules(doctorRules),
    });
    log?.info({ doctorId, scheduleId: schedule.id }, "[calendarSvc] created schedule for doctor");
  }

  // Persist scheduler IDs to the Doctor row.
  if (isNew || !doctor.schedulerDoctorId || !doctor.schedulerCalendarId) {
    await doctorSvc.saveSchedulerIds(supabaseClient, doctorId, {
      schedulerDoctorId: nettuUser.id,
      schedulerCalendarId: calendar.id,
    });
  }

  // Add doctor to clinic service (step 1: availability via schedule).
  if (clinic.schedulerServiceId) {
    try {
      await nettuClient.addUserToService(clinic.schedulerServiceId, {
        userId: nettuUser.id,
        scheduleId: schedule.id,
        bufferAfter: doctorRules.bufferMins,
      });
      log?.debug({ doctorId, serviceId: clinic.schedulerServiceId }, "[calendarSvc] added doctor to service");
    } catch (err) {
      if (err.httpStatus !== 409) throw err; // 409 = already a member, safe to ignore
    }

    // Step 2: register the appointment calendar as a busy source.
    try {
      await nettuClient.addBusyCalendar(clinic.schedulerServiceId, nettuUser.id, calendar.id);
      log?.debug({ doctorId, calendarId: calendar.id }, "[calendarSvc] registered busy calendar for doctor");
    } catch (err) {
      // 409 = already registered — safe to ignore.
      if (err.httpStatus !== 409) throw err;
    }
  }

  return { nettuUser, calendar, schedule, doctorRules, isNew };
}

module.exports = { getOrCreateClinicService, getOrCreateDoctorCalendar, buildScheduleRules };
