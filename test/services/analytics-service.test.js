const { test, describe } = require("node:test");
const assert = require("node:assert/strict");

const { getSummary } = require("../../src/services/analytics-service");
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
        // Within the last 30 days — the "current" window.
        dayRow(daysAgo(5), { revenue: 200 }),
        dayRow(daysAgo(10), { revenue: 300 }),
        // 31-60 days ago — the "previous" window.
        dayRow(daysAgo(40), { revenue: 50 }),
        dayRow(daysAgo(50), { revenue: 50 }),
        // Over 60 days ago — neither window.
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
