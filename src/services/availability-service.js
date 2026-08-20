// Queries the nettu-scheduler for available booking slots for a given doctor.
// Applies clinic policy (booking window, notice period) before returning results.

const clinicSvc = require("./clinic-service");
const doctorSvc = require("./doctor-service");

// ─── Timezone-safe date helpers ───────────────────────────────────────────────

// Convert epoch milliseconds to an ISO 8601 string with the correct offset for `timezone`.
// Example: epochToISO(1750000000000, "Asia/Kolkata") → "2025-06-15T18:16:40+05:30"
function epochToISO(epochMs, timezone) {
  const date = new Date(epochMs);

  // Determine UTC offset for this timezone at this moment.
  const utcDate = new Date(date.toLocaleString("en-US", { timeZone: "UTC" }));
  const tzDate = new Date(date.toLocaleString("en-US", { timeZone: timezone }));
  const offsetMs = tzDate.getTime() - utcDate.getTime();

  const localDate = new Date(epochMs + offsetMs);
  const pad = (n, w = 2) => String(n).padStart(w, "0");

  const Y = localDate.getUTCFullYear();
  const Mo = pad(localDate.getUTCMonth() + 1);
  const D = pad(localDate.getUTCDate());
  const h = pad(localDate.getUTCHours());
  const m = pad(localDate.getUTCMinutes());
  const s = pad(localDate.getUTCSeconds());

  const sign = offsetMs >= 0 ? "+" : "-";
  const absOff = Math.abs(Math.round(offsetMs / 60000));
  const offH = pad(Math.floor(absOff / 60));
  const offM = pad(absOff % 60);

  return `${Y}-${Mo}-${D}T${h}:${m}:${s}${sign}${offH}:${offM}`;
}

// Convert a local wall-clock date+time in `timezone` to a UTC ISO string.
// Inverse of epochToISO — for callers that only have a clock time ("4pm"),
// not an already-resolved instant. Doing this offset math is exactly the
// kind of arithmetic an LLM gets wrong under manual prompting (see
// assistant-tools.js), so it's centralized here as a single deterministic
// implementation instead.
// Example: localToUtcISO("2026-08-18", "16:00", "Asia/Kolkata") → "2026-08-18T10:30:00.000Z"
function localToUtcISO(dateStr, timeStr, timezone) {
  const [Y, Mo, D] = dateStr.split("-").map(Number);
  const [h, m] = timeStr.split(":").map(Number);
  const approxUtcMs = Date.UTC(Y, Mo - 1, D, h, m, 0);

  const approxDate = new Date(approxUtcMs);
  const utcDate = new Date(approxDate.toLocaleString("en-US", { timeZone: "UTC" }));
  const tzDate = new Date(approxDate.toLocaleString("en-US", { timeZone: timezone }));
  const offsetMs = tzDate.getTime() - utcDate.getTime();

  return new Date(approxUtcMs - offsetMs).toISOString();
}

// Human-readable "for a WhatsApp/SMS message" rendering, e.g. "2:45 PM, Mon 24 Aug" —
// distinct from epochToISO (machine-readable, used for computing/comparing
// instants) and from toUtcIso in lib/dates.js (a storage-layer marker fix,
// unrelated to display). Every {{apptTime}}/{{oldApptTime}} template
// placeholder should go through this, not a raw ISO string — confirmed live
// as a real bug otherwise (patients seeing "2026-08-24T14:45:00+05:30"
// verbatim in a WhatsApp message).
function formatHumanTime(epochMsOrDate, timezone) {
  const date = epochMsOrDate instanceof Date ? epochMsOrDate : new Date(epochMsOrDate);
  if (isNaN(date.getTime())) return null;
  const time = date.toLocaleTimeString("en-IN", { timeZone: timezone, hour: "numeric", minute: "2-digit", hour12: true });
  const day = date.toLocaleDateString("en-IN", { timeZone: timezone, weekday: "short", day: "numeric", month: "short" });
  return `${time}, ${day}`;
}

// Parse an ISO date string or Date-like value to a plain YYYY-MM-DD string.
function toDateString(value) {
  if (!value) return null;
  const d = new Date(value);
  if (isNaN(d.getTime())) return null;
  return d.toISOString().slice(0, 10);
}

// Clamp and validate the requested date range against the clinic's booking window.
function resolveBookingWindow(opts, clinicRules) {
  const now = Date.now();
  const minNotice = clinicRules.minNoticeHours * 60 * 60 * 1000;
  const earliest = new Date(now + minNotice);
  const latest = new Date(now + clinicRules.maxBookingWindowDays * 24 * 60 * 60 * 1000);

  let startDate, endDate;

  if (opts.dateRange?.start && opts.dateRange?.end) {
    startDate = toDateString(opts.dateRange.start);
    endDate = toDateString(opts.dateRange.end);
  } else if (opts.date) {
    startDate = toDateString(opts.date);
    endDate = startDate;
  } else {
    // Default: today through maxBookingWindowDays.
    startDate = toDateString(earliest);
    endDate = toDateString(latest);
  }

  if (!startDate || !endDate) {
    throw Object.assign(new Error("Invalid date or dateRange provided"), { code: "INVALID_DATE", statusCode: 400 });
  }

  // Reject requests entirely outside the booking window.
  const requestedStart = new Date(startDate);
  const requestedEnd = new Date(endDate);

  if (requestedEnd < earliest) {
    throw Object.assign(new Error("Requested date range is outside the minimum notice period"), {
      code: "OUTSIDE_BOOKING_WINDOW",
      statusCode: 422,
    });
  }
  if (requestedStart > latest) {
    throw Object.assign(
      new Error(`Requested date range exceeds the ${clinicRules.maxBookingWindowDays}-day booking window`),
      { code: "OUTSIDE_BOOKING_WINDOW", statusCode: 422 },
    );
  }

  // Clamp to the bookable window.
  if (requestedStart < earliest) startDate = toDateString(earliest);
  if (requestedEnd > latest) endDate = toDateString(latest);

  return { startDate, endDate };
}

// Recurring daily breaks (Doctor.breaks — see the onboarding migration and
// doctor-service.js) apply the same way every working day, so filtering is
// purely a same-day local-time overlap check — no calendar event exists for
// nettu-scheduler to already exclude these on its own.
function localMinutesOfDay(epochMs, timezone) {
  const iso = epochToISO(epochMs, timezone);
  const match = iso.match(/T(\d{2}):(\d{2})/);
  if (!match) return null;
  return Number(match[1]) * 60 + Number(match[2]);
}

function overlapsBreak(startMs, endMs, timezone, breaks) {
  if (!breaks?.length) return false;
  const startMin = localMinutesOfDay(startMs, timezone);
  const endMin = localMinutesOfDay(endMs, timezone);
  if (startMin == null || endMin == null) return false;
  return breaks.some((b) => {
    const [bsH, bsM] = String(b?.start ?? "").split(":").map(Number);
    const [beH, beM] = String(b?.end ?? "").split(":").map(Number);
    if (Number.isNaN(bsH) || Number.isNaN(beH)) return false;
    const breakStart = bsH * 60 + (bsM || 0);
    const breakEnd = beH * 60 + (beM || 0);
    return startMin < breakEnd && endMin > breakStart;
  });
}

// ─── Public ───────────────────────────────────────────────────────────────────

// Returns an array of bookable slot objects for the requested doctor and date range.
// opts: { clinicId, doctorId, date?, dateRange?: { start, end }, timezone? }
async function getAvailableSlots(nettuClient, supabaseClient, opts, log) {
  const clinic = await clinicSvc.requireActiveClinic(supabaseClient, opts.clinicId);
  const doctor = await doctorSvc.requireActiveDoctor(supabaseClient, opts.doctorId, opts.clinicId);
  const clinicRules = clinicSvc.getSchedulingRules(clinic);
  const doctorRules = doctorSvc.getSchedulingRules(doctor, clinicRules);
  const timezone = opts.timezone ?? doctorRules.timezone;

  if (!clinic.schedulerServiceId) {
    throw Object.assign(new Error("Clinic calendar is not configured — run the setup script first"), {
      code: "SCHEDULER_API_ERROR",
      statusCode: 500,
    });
  }
  if (!doctor.schedulerDoctorId) {
    throw Object.assign(new Error("Doctor calendar is not configured — run the setup script first"), {
      code: "SCHEDULER_API_ERROR",
      statusCode: 500,
    });
  }

  const { startDate, endDate } = resolveBookingWindow(opts, clinicRules);
  const duration = doctorRules.slotDurationMins;

  log?.info(
    { clinicId: opts.clinicId, doctorId: opts.doctorId, startDate, endDate, duration, timezone },
    "[availabilitySvc] fetching booking slots",
  );

  const durationMs = duration * 60 * 1000; // convert minutes → milliseconds

  const rawSlots = await nettuClient.getBookingSlots(clinic.schedulerServiceId, {
    hostUserId: doctor.schedulerDoctorId,
    startDate,
    endDate,
    durationMs,
    intervalMs: durationMs, // interval = duration (back-to-back; bufferAfter handles gap)
    timezone,
  });

  const now = Date.now();

  const slots = rawSlots
    .filter((slot) => {
      // nettu may return start as epoch ms or as an ISO string
      const startMs = typeof slot.start === "number" ? slot.start : new Date(slot.start).getTime();
      if (startMs <= now) return false; // never return past slots
      const slotDurMs = slot.duration ?? durationMs;
      return !overlapsBreak(startMs, startMs + slotDurMs, timezone, doctor.breaks);
    })
    .map((slot) => {
      const startMs = typeof slot.start === "number" ? slot.start : new Date(slot.start).getTime();
      // slot.duration from nettu is in milliseconds
      const slotDurMs = slot.duration ?? durationMs;
      const slotDurMin = Math.round(slotDurMs / 60_000);
      const endMs = startMs + slotDurMs;

      return {
        slotId: `slot_${startMs}`,
        start: epochToISO(startMs, timezone),
        end: epochToISO(endMs, timezone),
        durationMinutes: slotDurMin,
        doctorId: opts.doctorId,
        clinicId: opts.clinicId,
      };
    });

  return { slots, timezone, startDate, endDate };
}

module.exports = { getAvailableSlots, epochToISO, formatHumanTime, toDateString, localToUtcISO };
