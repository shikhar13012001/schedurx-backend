const { test, describe } = require("node:test");
const assert = require("node:assert/strict");

const {
  getSummary,
  getRevenueByDoctor,
  getRevenueByMode,
  getOutstandingInvoices,
  getNoShowRate,
  getQueueTimings,
  getReturnRateByDoctor,
  getRepeatVisitTrend,
} = require("../../src/services/analytics-service");
const { createTableStub } = require("../helpers/supabase-table-stub");

function dayRow(day, overrides = {}) {
  return { clinicId: "clinic-1", day, appointments: 1, revenue: 100, cancellations: 0, ...overrides };
}

describe("getSummary", () => {
  test("sums the requested window and separately sums the immediately preceding window of the same length", async () => {
    const now = new Date();
    const daysAgo = (n) => new Date(now.getTime() - n * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

    const supabaseClient = createTableStub({
      day_stats: [
        dayRow(daysAgo(5), { revenue: 200 }),
        dayRow(daysAgo(10), { revenue: 300 }),
        dayRow(daysAgo(40), { revenue: 50 }),
        dayRow(daysAgo(50), { revenue: 50 }),
        dayRow(daysAgo(90), { revenue: 999 }),
      ],
    });

    const summary = await getSummary(supabaseClient, "clinic-1", { days: 30 });

    assert.equal(summary.totals.revenue, 500);
    assert.equal(summary.totals.appointments, 2);
    assert.equal(summary.previousTotals.revenue, 100);
    assert.equal(summary.previousTotals.appointments, 2);
  });

  test("previousTotals is all zeros (not an error) when there's no data in that window", async () => {
    const supabaseClient = createTableStub({ day_stats: [] });
    const summary = await getSummary(supabaseClient, "clinic-1", { days: 30 });
    assert.deepEqual(summary.previousTotals, { appointments: 0, revenue: 0, cancellations: 0 });
  });
});

describe("getRevenueByDoctor", () => {
  test("attributes paid invoices to the doctor of their linked appointment", async () => {
    const now = new Date().toISOString();
    const supabaseClient = createTableStub({
      Invoice: [
        { id: "inv-1", clinicId: "clinic-1", appointmentId: "apt-1", amountInr: 200, status: "paid", paidAt: now },
        { id: "inv-2", clinicId: "clinic-1", appointmentId: "apt-2", amountInr: 300, status: "paid", paidAt: now },
        { id: "inv-3", clinicId: "clinic-1", appointmentId: "apt-3", amountInr: 999, status: "pending", paidAt: null },
      ],
      Appointment: [
        { id: "apt-1", clinicId: "clinic-1", doctorId: "doc-a" },
        { id: "apt-2", clinicId: "clinic-1", doctorId: "doc-b" },
      ],
      Doctor: [
        { id: "doc-a", clinicId: "clinic-1", fullName: "Dr. A" },
        { id: "doc-b", clinicId: "clinic-1", fullName: "Dr. B" },
      ],
    });
    const result = await getRevenueByDoctor(supabaseClient, "clinic-1", { days: 30 });
    assert.deepEqual(result, [
      { doctorId: "doc-b", doctorName: "Dr. B", amountInr: 300 },
      { doctorId: "doc-a", doctorName: "Dr. A", amountInr: 200 },
    ]);
  });

  test("returns an empty array when there are no paid invoices", async () => {
    const supabaseClient = createTableStub({ Invoice: [] });
    const result = await getRevenueByDoctor(supabaseClient, "clinic-1", { days: 30 });
    assert.deepEqual(result, []);
  });
});

describe("getRevenueByMode", () => {
  test("groups paid invoice revenue by the linked appointment's mode", async () => {
    const now = new Date().toISOString();
    const supabaseClient = createTableStub({
      Invoice: [
        { id: "inv-1", clinicId: "clinic-1", appointmentId: "apt-1", amountInr: 200, status: "paid", paidAt: now },
        { id: "inv-2", clinicId: "clinic-1", appointmentId: "apt-2", amountInr: 100, status: "paid", paidAt: now },
      ],
      Appointment: [
        { id: "apt-1", clinicId: "clinic-1", mode: "video" },
        { id: "apt-2", clinicId: "clinic-1", mode: "clinic" },
      ],
    });
    const result = await getRevenueByMode(supabaseClient, "clinic-1", { days: 30 });
    assert.deepEqual(result, [
      { mode: "video", amountInr: 200 },
      { mode: "clinic", amountInr: 100 },
    ]);
  });
});

describe("getOutstandingInvoices", () => {
  test("sums pending and failed invoices, excluding paid ones", async () => {
    const supabaseClient = createTableStub({
      Invoice: [
        { id: "inv-1", clinicId: "clinic-1", patientId: "pat-1", amountInr: 200, status: "pending", createdAt: "2026-01-01" },
        { id: "inv-2", clinicId: "clinic-1", patientId: "pat-2", amountInr: 100, status: "failed", createdAt: "2026-01-02" },
        { id: "inv-3", clinicId: "clinic-1", patientId: "pat-3", amountInr: 500, status: "paid", createdAt: "2026-01-03" },
      ],
    });
    const result = await getOutstandingInvoices(supabaseClient, "clinic-1");
    assert.equal(result.count, 2);
    assert.equal(result.amountInr, 300);
  });
});

describe("getNoShowRate", () => {
  test("computes real no-shows against a denominator that excludes cancelled and blocked", async () => {
    const supabaseClient = createTableStub({
      Appointment: [
        { clinicId: "clinic-1", status: "no_show", timeslot: "2026-01-05T00:00:00Z" },
        { clinicId: "clinic-1", status: "completed", timeslot: "2026-01-05T00:00:00Z" },
        { clinicId: "clinic-1", status: "completed", timeslot: "2026-01-05T00:00:00Z" },
        { clinicId: "clinic-1", status: "cancelled", timeslot: "2026-01-05T00:00:00Z" },
        { clinicId: "clinic-1", status: "blocked", timeslot: "2026-01-05T00:00:00Z" },
      ],
    });
    const result = await getNoShowRate(supabaseClient, "clinic-1", { days: 3650 });
    assert.equal(result.total, 3); // cancelled + blocked excluded
    assert.equal(result.noShows, 1);
    assert.equal(result.noShowRatePct, 33);
  });
});

describe("getQueueTimings", () => {
  test("computes average wait and visit duration from real timestamps only", async () => {
    const now = new Date().toISOString();
    const supabaseClient = createTableStub({
      QueueItem: [
        // 10 min wait, 20 min visit
        { clinicId: "clinic-1", checkedInAt: now, calledAt: new Date(Date.now() + 10 * 60_000).toISOString(), completedAt: new Date(Date.now() + 30 * 60_000).toISOString() },
        // 20 min wait, no visit duration yet (still in room)
        { clinicId: "clinic-1", checkedInAt: now, calledAt: new Date(Date.now() + 20 * 60_000).toISOString(), completedAt: null },
        // still waiting — contributes to neither average
        { clinicId: "clinic-1", checkedInAt: now, calledAt: null, completedAt: null },
      ],
    });
    const result = await getQueueTimings(supabaseClient, "clinic-1", { days: 30 });
    assert.equal(result.avgWaitMinutes, 15); // (10+20)/2
    assert.equal(result.avgVisitMinutes, 20);
    assert.deepEqual(result.sampleSize, { wait: 2, visit: 1 });
  });

  test("returns null averages (not NaN/0) when there's no data yet", async () => {
    const supabaseClient = createTableStub({ QueueItem: [] });
    const result = await getQueueTimings(supabaseClient, "clinic-1", { days: 30 });
    assert.equal(result.avgWaitMinutes, null);
    assert.equal(result.avgVisitMinutes, null);
  });
});

describe("getReturnRateByDoctor", () => {
  test("computes return rate per doctor independently — a patient can be new to one doctor and returning to another", async () => {
    const supabaseClient = createTableStub({
      Visit: [
        { clinicId: "clinic-1", doctorId: "doc-a", patientId: "pat-1" },
        { clinicId: "clinic-1", doctorId: "doc-a", patientId: "pat-1" }, // returning to doc-a
        { clinicId: "clinic-1", doctorId: "doc-a", patientId: "pat-2" }, // new to doc-a
        { clinicId: "clinic-1", doctorId: "doc-b", patientId: "pat-1" }, // new to doc-b (even though returning overall)
      ],
      Doctor: [
        { id: "doc-a", clinicId: "clinic-1", fullName: "Dr. A" },
        { id: "doc-b", clinicId: "clinic-1", fullName: "Dr. B" },
      ],
    });
    const result = await getReturnRateByDoctor(supabaseClient, "clinic-1");
    const byDoctor = Object.fromEntries(result.map((r) => [r.doctorId, r]));
    assert.equal(byDoctor["doc-a"].totalPatients, 2);
    assert.equal(byDoctor["doc-a"].returningPatients, 1);
    assert.equal(byDoctor["doc-a"].returnRatePct, 50);
    assert.equal(byDoctor["doc-b"].returnRatePct, 0);
  });
});

describe("getRepeatVisitTrend", () => {
  test("counts a visit as 'repeat' only if the same patient had a visit before that calendar month", async () => {
    // Dated relative to "now" (not hardcoded) so this test is correct
    // regardless of which real-world date the suite happens to run on —
    // the function's own window is always "the last N months from today".
    const now = new Date();
    const lastMonth = new Date(now.getFullYear(), now.getMonth() - 1, 10);
    const thisMonth = new Date(now.getFullYear(), now.getMonth(), 5);
    const toDateStr = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

    const supabaseClient = createTableStub({
      Visit: [
        { clinicId: "clinic-1", patientId: "pat-1", visitDate: toDateStr(lastMonth) }, // pat-1's first ever visit
        { clinicId: "clinic-1", patientId: "pat-1", visitDate: toDateStr(thisMonth) }, // repeat (had a visit last month)
        { clinicId: "clinic-1", patientId: "pat-2", visitDate: toDateStr(thisMonth) }, // new this month
      ],
    });
    const result = await getRepeatVisitTrend(supabaseClient, "clinic-1", { months: 2 });
    const totalRepeats = result.reduce((sum, r) => sum + r.repeatVisits, 0);
    assert.equal(totalRepeats, 1);
    const thisMonthKey = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
    const thisMonthRow = result.find((r) => r.month === thisMonthKey);
    assert.equal(thisMonthRow.totalVisits, 2);
    assert.equal(thisMonthRow.repeatVisits, 1);
    assert.equal(thisMonthRow.repeatRatePct, 50);
  });
});
