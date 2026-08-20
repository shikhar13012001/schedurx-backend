const { test, describe } = require("node:test");
const assert = require("node:assert/strict");

const pushSvc = require("../../src/services/push-service");
const { createTableStub } = require("../helpers/supabase-table-stub");

describe("listSubscriptionsForStaff", () => {
  test("returns only this staff member's subscriptions", async () => {
    const supabaseClient = createTableStub({
      PushSubscription: [
        { id: "p1", staffId: "staff-1", endpoint: "https://push.example/1", keys: {} },
        { id: "p2", staffId: "staff-2", endpoint: "https://push.example/2", keys: {} },
      ],
    });
    const subs = await pushSvc.listSubscriptionsForStaff(supabaseClient, "staff-1");
    assert.equal(subs.length, 1);
    assert.equal(subs[0].id, "p1");
  });
});

describe("listSubscriptionsForClinic", () => {
  test("fans out to every active staff member's subscriptions in the clinic", async () => {
    const supabaseClient = createTableStub({
      Staff: [
        { id: "staff-1", clinicId: "clinic-1", isActive: true },
        { id: "staff-2", clinicId: "clinic-1", isActive: true },
        { id: "staff-3", clinicId: "clinic-2", isActive: true },
      ],
      PushSubscription: [
        { id: "p1", staffId: "staff-1", endpoint: "https://push.example/1", keys: {} },
        { id: "p2", staffId: "staff-2", endpoint: "https://push.example/2", keys: {} },
        { id: "p3", staffId: "staff-3", endpoint: "https://push.example/3", keys: {} },
      ],
    });
    const subs = await pushSvc.listSubscriptionsForClinic(supabaseClient, "clinic-1");
    assert.equal(subs.length, 2);
    assert.deepEqual(
      subs.map((s) => s.id).sort(),
      ["p1", "p2"],
    );
  });

  test("excludes an inactive staff member's subscription", async () => {
    const supabaseClient = createTableStub({
      Staff: [
        { id: "staff-1", clinicId: "clinic-1", isActive: true },
        { id: "staff-2", clinicId: "clinic-1", isActive: false },
      ],
      PushSubscription: [
        { id: "p1", staffId: "staff-1", endpoint: "https://push.example/1", keys: {} },
        { id: "p2", staffId: "staff-2", endpoint: "https://push.example/2", keys: {} },
      ],
    });
    const subs = await pushSvc.listSubscriptionsForClinic(supabaseClient, "clinic-1");
    assert.equal(subs.length, 1);
    assert.equal(subs[0].id, "p1");
  });

  test("returns [] for a clinic with no staff at all", async () => {
    const supabaseClient = createTableStub({ Staff: [], PushSubscription: [] });
    const subs = await pushSvc.listSubscriptionsForClinic(supabaseClient, "clinic-1");
    assert.deepEqual(subs, []);
  });
});

describe("sendPush", () => {
  test("no-ops when VAPID isn't configured (test env has no VAPID keys)", async () => {
    const result = await pushSvc.sendPush({ endpoint: "https://push.example/1", keys: {} }, { title: "hi" }, null);
    assert.equal(result.stubbed, true);
    assert.equal(result.ok, true);
  });
});
