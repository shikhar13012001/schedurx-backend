// Reads the day_stats materialized view (supabase/migrations/20260807_billing_analytics.sql).
// Refreshed on-demand via the refresh_day_stats() RPC rather than on a schedule —
// no cron/Redis dependency introduced for this pass (see the backend plan's
// BullMQ/Redis deferral).

function dbErr(msg) {
  return Object.assign(new Error(`DB error ${msg}`), { code: "DATABASE_ERROR", statusCode: 500 });
}

async function getSummary(supabaseClient, clinicId, { days = 30 } = {}) {
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

  const { data, error } = await supabaseClient
    .from("day_stats")
    .select("*")
    .eq("clinicId", clinicId)
    .gte("day", since)
    .order("day", { ascending: true });
  if (error) throw dbErr(`reading day_stats: ${error.message}`);

  const rows = data ?? [];
  const totals = rows.reduce(
    (acc, row) => ({
      appointments: acc.appointments + (row.appointments ?? 0),
      revenue: acc.revenue + Number(row.revenue ?? 0),
      cancellations: acc.cancellations + (row.cancellations ?? 0),
    }),
    { appointments: 0, revenue: 0, cancellations: 0 },
  );

  return { daily: rows, totals };
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

module.exports = { getSummary, getUtilization, refresh };
