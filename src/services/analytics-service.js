// Reads the day_stats materialized view (supabase/migrations/20260807_billing_analytics.sql).
// Refreshed on-demand via the refresh_day_stats() RPC rather than on a schedule —
// no cron/Redis dependency introduced for this pass (see the backend plan's
// BullMQ/Redis deferral).

function dbErr(msg) {
  return Object.assign(new Error(`DB error ${msg}`), { code: "DATABASE_ERROR", statusCode: 500 });
}

function sumDayStats(rows) {
  return rows.reduce(
    (acc, row) => ({
      appointments: acc.appointments + (row.appointments ?? 0),
      revenue: acc.revenue + Number(row.revenue ?? 0),
      cancellations: acc.cancellations + (row.cancellations ?? 0),
    }),
    { appointments: 0, revenue: 0, cancellations: 0 },
  );
}

// previousTotals is the immediately preceding window of the same length
// (days 31-60 back, for the default 30-day summary) — real month-over-month
// comparison, not a placeholder. Live-reported gap (2026-09-08): the
// dashboard was showing a hardcoded "+9% from last month" regardless of
// actual data; this is what a real trend figure needs to be computed from.
async function getSummary(supabaseClient, clinicId, { days = 30 } = {}) {
  const now = Date.now();
  const dayMs = 24 * 60 * 60 * 1000;
  const since = new Date(now - days * dayMs).toISOString().slice(0, 10);
  const previousSince = new Date(now - days * 2 * dayMs).toISOString().slice(0, 10);

  const [{ data, error }, { data: previousData, error: previousError }] = await Promise.all([
    supabaseClient.from("day_stats").select("*").eq("clinicId", clinicId).gte("day", since).order("day", { ascending: true }),
    supabaseClient.from("day_stats").select("*").eq("clinicId", clinicId).gte("day", previousSince).lt("day", since),
  ]);
  if (error) throw dbErr(`reading day_stats: ${error.message}`);
  if (previousError) throw dbErr(`reading previous day_stats: ${previousError.message}`);

  const rows = data ?? [];
  return { daily: rows, totals: sumDayStats(rows), previousTotals: sumDayStats(previousData ?? []) };
}

const DAY_ABBR = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function minutesBetween(startStr, endStr) {
  const [sh, sm] = startStr.split(":").map(Number);
  const [eh, em] = endStr.split(":").map(Number);
  return eh * 60 + em - (sh * 60 + sm);
}

// Computed analytically from Clinic/Doctor working-hours columns + Appointment
// counts — no nettu-scheduler calls needed. "Possible slots" assumes back-to-back
// booking at the doctor's slot duration; "booked" counts anything not cancelled
// (including time-blocks, which do consume real calendar capacity).
async function getUtilization(supabaseClient, clinicId, { days = 7 } = {}) {
  const { data: clinic, error: clinicErr } = await supabaseClient
    .from("Clinic")
    .select("workingDays, openingHour, closingHour, defaultAppointmentDurationMins")
    .eq("id", clinicId)
    .maybeSingle();
  if (clinicErr) throw dbErr(`reading clinic: ${clinicErr.message}`);
  if (!clinic) throw Object.assign(new Error("Clinic not found"), { code: "CLINIC_NOT_FOUND", statusCode: 404 });

  const { data: doctors, error: docErr } = await supabaseClient
    .from("Doctor")
    .select("id, fullName, workingDaysOverride, workingHoursStart, workingHoursEnd, slotDurationOverrideMins")
    .eq("clinicId", clinicId)
    .eq("isActive", true);
  if (docErr) throw dbErr(`listing doctors: ${docErr.message}`);

  const since = new Date();
  since.setDate(since.getDate() - (days - 1));
  const sinceStr = since.toISOString().slice(0, 10);

  const { data: appointments, error: aptErr } = await supabaseClient
    .from("Appointment")
    .select("id, doctorId, status")
    .eq("clinicId", clinicId)
    .gte("timeslot", `${sinceStr}T00:00:00`)
    .neq("status", "cancelled");
  if (aptErr) throw dbErr(`listing appointments: ${aptErr.message}`);

  const clinicWorkingDays = Array.isArray(clinic.workingDays) ? clinic.workingDays : [];
  const clinicStart = `${String(clinic.openingHour).padStart(2, "0")}:00`;
  const clinicEnd = `${String(clinic.closingHour).padStart(2, "0")}:00`;

  const doctorRows = (doctors ?? []).map((doc) => {
    const workingDays = doc.workingDaysOverride ?? clinicWorkingDays;
    const startStr = doc.workingHoursStart ?? clinicStart;
    const endStr = doc.workingHoursEnd ?? clinicEnd;
    const slotMins = doc.slotDurationOverrideMins ?? clinic.defaultAppointmentDurationMins ?? 30;
    const dailyMinutes = Math.max(0, minutesBetween(startStr, endStr));
    const slotsPerDay = slotMins > 0 ? Math.floor(dailyMinutes / slotMins) : 0;

    let workingDaysInRange = 0;
    for (let i = 0; i < days; i++) {
      const d = new Date(since);
      d.setDate(d.getDate() + i);
      if (workingDays.includes(DAY_ABBR[d.getDay()])) workingDaysInRange++;
    }

    const totalPossibleSlots = slotsPerDay * workingDaysInRange;
    const bookedSlots = appointments.filter((a) => a.doctorId === doc.id).length;
    const utilizationPct = totalPossibleSlots > 0 ? Math.round((bookedSlots / totalPossibleSlots) * 100) : 0;

    return { doctorId: doc.id, doctorName: doc.fullName, totalPossibleSlots, bookedSlots, utilizationPct };
  });

  return { days, doctors: doctorRows };
}

async function refresh(supabaseClient) {
  const { error } = await supabaseClient.rpc("refresh_day_stats");
  if (error) throw dbErr(`refreshing day_stats: ${error.message}`);
}

// ─── Enterprise analytics ───────────────────────────────────────────────────
// Reads live tables directly (Invoice/Appointment/QueueItem/Visit), not the
// day_stats view above — that view only ever aggregated appointments/revenue/
// cancellations, with no doctor/mode/queue-timing breakdown. Two-query
// "fetch then reduce in JS" shape throughout, matching listPossibleNoShows'
// established pattern in this codebase, rather than a raw SQL join — no new
// migration, and each piece stays independently testable.

function daysAgoIso(days) {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
}

// Revenue is real Invoice rows only (see invoice-service.js's
// recordPaidTokenPayment) — never invented from Doctor.feeInr, which is a
// displayed/configured number, not something ever actually charged anywhere
// in this codebase today.
async function getRevenueByDoctor(supabaseClient, clinicId, { days = 30 } = {}) {
  const since = daysAgoIso(days);
  const { data: invoices, error } = await supabaseClient
    .from("Invoice")
    .select("appointmentId, amountInr")
    .eq("clinicId", clinicId)
    .eq("status", "paid")
    .gte("paidAt", since);
  if (error) throw dbErr(`reading invoices: ${error.message}`);
  const paidInvoices = (invoices ?? []).filter((inv) => inv.appointmentId);
  if (!paidInvoices.length) return [];

  const appointmentIds = [...new Set(paidInvoices.map((inv) => inv.appointmentId))];
  const { data: appointments, error: apptErr } = await supabaseClient
    .from("Appointment")
    .select("id, doctorId")
    .in("id", appointmentIds);
  if (apptErr) throw dbErr(`reading appointments: ${apptErr.message}`);
  const doctorIdByAppointment = new Map((appointments ?? []).map((a) => [a.id, a.doctorId]));

  const { data: doctors, error: doctorErr } = await supabaseClient.from("Doctor").select("id, fullName").eq("clinicId", clinicId);
  if (doctorErr) throw dbErr(`reading doctors: ${doctorErr.message}`);
  const nameByDoctor = new Map((doctors ?? []).map((d) => [d.id, d.fullName]));

  const totals = new Map(); // doctorId -> amountInr
  for (const inv of paidInvoices) {
    const doctorId = doctorIdByAppointment.get(inv.appointmentId);
    if (!doctorId) continue;
    totals.set(doctorId, (totals.get(doctorId) ?? 0) + Number(inv.amountInr));
  }

  return [...totals.entries()]
    .map(([doctorId, amountInr]) => ({ doctorId, doctorName: nameByDoctor.get(doctorId) ?? "Unknown", amountInr }))
    .sort((a, b) => b.amountInr - a.amountInr);
}

// "By service" — this codebase has no service/procedure catalog, so mode
// (clinic/video/audio/text) is the closest real dimension revenue can be
// broken down by; labeled as such rather than inventing a fake taxonomy.
async function getRevenueByMode(supabaseClient, clinicId, { days = 30 } = {}) {
  const since = daysAgoIso(days);
  const { data: invoices, error } = await supabaseClient
    .from("Invoice")
    .select("appointmentId, amountInr")
    .eq("clinicId", clinicId)
    .eq("status", "paid")
    .gte("paidAt", since);
  if (error) throw dbErr(`reading invoices: ${error.message}`);
  const paidInvoices = (invoices ?? []).filter((inv) => inv.appointmentId);
  if (!paidInvoices.length) return [];

  const appointmentIds = [...new Set(paidInvoices.map((inv) => inv.appointmentId))];
  const { data: appointments, error: apptErr } = await supabaseClient
    .from("Appointment")
    .select("id, mode")
    .in("id", appointmentIds);
  if (apptErr) throw dbErr(`reading appointments: ${apptErr.message}`);
  const modeByAppointment = new Map((appointments ?? []).map((a) => [a.id, a.mode ?? "clinic"]));

  const totals = new Map();
  for (const inv of paidInvoices) {
    const mode = modeByAppointment.get(inv.appointmentId) ?? "clinic";
    totals.set(mode, (totals.get(mode) ?? 0) + Number(inv.amountInr));
  }
  return [...totals.entries()].map(([mode, amountInr]) => ({ mode, amountInr })).sort((a, b) => b.amountInr - a.amountInr);
}

async function getOutstandingInvoices(supabaseClient, clinicId) {
  const { data, error } = await supabaseClient
    .from("Invoice")
    .select("id, patientId, amountInr, status, createdAt")
    .eq("clinicId", clinicId)
    .in("status", ["pending", "failed"])
    .order("createdAt", { ascending: false });
  if (error) throw dbErr(`reading outstanding invoices: ${error.message}`);
  const rows = data ?? [];
  return { count: rows.length, amountInr: rows.reduce((sum, r) => sum + Number(r.amountInr), 0), invoices: rows };
}

// A real no-show rate, distinct from day_stats' existing "noShowRate" (which
// the migration's own comment already admits is actually cancellations —
// see getSummary above). Denominator excludes cancelled appointments (never
// happened at all, not a no-show) and blocked time (not a patient booking).
async function getNoShowRate(supabaseClient, clinicId, { days = 30 } = {}) {
  const since = daysAgoIso(days).slice(0, 10);
  const { data, error } = await supabaseClient
    .from("Appointment")
    .select("status")
    .eq("clinicId", clinicId)
    .gte("timeslot", since);
  if (error) throw dbErr(`reading appointments: ${error.message}`);
  // Excludes cancelled (never happened at all, not a no-show) and blocked
  // time (not a patient booking) — filtered in JS rather than a .not() query
  // filter, matching this function's own established "fetch, reduce in JS"
  // shape throughout the file.
  const rows = (data ?? []).filter((r) => r.status !== "cancelled" && r.status !== "blocked");
  const noShows = rows.filter((r) => r.status === "no_show").length;
  return { total: rows.length, noShows, noShowRatePct: rows.length ? Math.round((noShows / rows.length) * 100) : 0 };
}

// Real wait time (checked in -> called in) and real visit duration (called
// in -> completed) from QueueItem's own timestamps — both null-safe per row
// (a still-waiting or still-in-room entry contributes to neither average).
async function getQueueTimings(supabaseClient, clinicId, { days = 30 } = {}) {
  const since = daysAgoIso(days);
  const { data, error } = await supabaseClient
    .from("QueueItem")
    .select("checkedInAt, calledAt, completedAt")
    .eq("clinicId", clinicId)
    .gte("checkedInAt", since);
  if (error) throw dbErr(`reading queue timings: ${error.message}`);

  const waitMinutes = [];
  const visitMinutes = [];
  for (const row of data ?? []) {
    if (row.checkedInAt && row.calledAt) {
      waitMinutes.push((new Date(row.calledAt).getTime() - new Date(row.checkedInAt).getTime()) / 60_000);
    }
    if (row.calledAt && row.completedAt) {
      visitMinutes.push((new Date(row.completedAt).getTime() - new Date(row.calledAt).getTime()) / 60_000);
    }
  }
  const avg = (arr) => (arr.length ? Math.round(arr.reduce((a, b) => a + b, 0) / arr.length) : null);
  return { avgWaitMinutes: avg(waitMinutes), avgVisitMinutes: avg(visitMinutes), sampleSize: { wait: waitMinutes.length, visit: visitMinutes.length } };
}

// Return rate PER DOCTOR — distinct from the patient-list-wide visitsCount
// (a patient could be a first-timer with Dr. A but a regular with Dr. B).
// Grouped from real Visit rows, all-time (not window-scoped) since "does
// this patient come back to this doctor" isn't a recent-window question.
async function getReturnRateByDoctor(supabaseClient, clinicId) {
  const { data, error } = await supabaseClient.from("Visit").select("doctorId, patientId").eq("clinicId", clinicId);
  if (error) throw dbErr(`reading visits: ${error.message}`);

  const { data: doctors, error: doctorErr } = await supabaseClient.from("Doctor").select("id, fullName").eq("clinicId", clinicId);
  if (doctorErr) throw dbErr(`reading doctors: ${doctorErr.message}`);
  const nameByDoctor = new Map((doctors ?? []).map((d) => [d.id, d.fullName]));

  // doctorId -> patientId -> visit count
  const byDoctor = new Map();
  for (const visit of data ?? []) {
    if (!visit.doctorId || !visit.patientId) continue;
    if (!byDoctor.has(visit.doctorId)) byDoctor.set(visit.doctorId, new Map());
    const byPatient = byDoctor.get(visit.doctorId);
    byPatient.set(visit.patientId, (byPatient.get(visit.patientId) ?? 0) + 1);
  }

  return [...byDoctor.entries()]
    .map(([doctorId, byPatient]) => {
      const patientCounts = [...byPatient.values()];
      const returning = patientCounts.filter((n) => n > 1).length;
      return {
        doctorId,
        doctorName: nameByDoctor.get(doctorId) ?? "Unknown",
        totalPatients: patientCounts.length,
        returningPatients: returning,
        returnRatePct: patientCounts.length ? Math.round((returning / patientCounts.length) * 100) : 0,
      };
    })
    .sort((a, b) => b.returnRatePct - a.returnRatePct);
}

// Monthly cohort trend: of all visits IN a given month, what share belong to
// a patient who already had at least one visit before that month began
// (any doctor) — a real "are patients coming back over time" signal, not a
// single snapshot number. months=6 means the current month plus the 5 before it.
async function getRepeatVisitTrend(supabaseClient, clinicId, { months = 6 } = {}) {
  const { data, error } = await supabaseClient.from("Visit").select("patientId, visitDate").eq("clinicId", clinicId);
  if (error) throw dbErr(`reading visits: ${error.message}`);
  const visits = (data ?? []).filter((v) => v.patientId && v.visitDate).sort((a, b) => a.visitDate.localeCompare(b.visitDate));
  if (!visits.length) return [];

  const now = new Date();
  const monthKeys = [];
  for (let i = months - 1; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    monthKeys.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`);
  }

  const firstVisitByPatient = new Map();
  for (const v of visits) {
    if (!firstVisitByPatient.has(v.patientId)) firstVisitByPatient.set(v.patientId, v.visitDate);
  }

  return monthKeys.map((monthKey) => {
    const inMonth = visits.filter((v) => v.visitDate.slice(0, 7) === monthKey);
    const repeat = inMonth.filter((v) => firstVisitByPatient.get(v.patientId) < `${monthKey}-01`).length;
    return {
      month: monthKey,
      totalVisits: inMonth.length,
      repeatVisits: repeat,
      repeatRatePct: inMonth.length ? Math.round((repeat / inMonth.length) * 100) : 0,
    };
  });
}

module.exports = {
  getSummary,
  getUtilization,
  refresh,
  getRevenueByDoctor,
  getRevenueByMode,
  getOutstandingInvoices,
  getNoShowRate,
  getQueueTimings,
  getReturnRateByDoctor,
  getRepeatVisitTrend,
};
