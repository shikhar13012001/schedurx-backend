const availabilitySvc = require("../services/availability-service");
const { toDateString } = require("../services/availability-service");
const { ok, fail } = require("../lib/response-envelope");

function isValidTimezone(tz) {
  if (!tz || typeof tz !== "string") return false;
  try {
    Intl.DateTimeFormat(undefined, { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

async function fetchAlternatives(nettuClient, supabaseClient, { clinicId, doctorId, fromIso }, log) {
  try {
    const startDate = (typeof fromIso === "string" ? fromIso : new Date().toISOString()).slice(0, 10);
    const endDate = toDateString(new Date(new Date(startDate + "T00:00:00Z").getTime() + 7 * 24 * 60 * 60 * 1000));
    const result = await availabilitySvc.getAvailableSlots(
      nettuClient,
      supabaseClient,
      { clinicId, doctorId, dateRange: { start: startDate, end: endDate } },
      log,
    );
    return result.slots.slice(0, 3);
  } catch {
    return [];
  }
}

module.exports = {
  ok,
  fail,
  isValidTimezone,
  fetchAlternatives,
};
