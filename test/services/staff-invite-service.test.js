const { test, describe } = require("node:test");
const assert = require("node:assert/strict");

const staffInviteSvc = require("../../src/services/staff-invite-service");
const { createTableStub } = require("../helpers/supabase-table-stub");

function makeFirebaseAdminStub() {
  const calls = [];
  return {
    calls,
    setCustomUserClaims: async (uid, claims) => {
      calls.push({ uid, claims });
    },
  };
}

describe("createInvite", () => {
  test("creates a pending invite with a real token and expiry", async () => {
    const supabaseClient = createTableStub({});
    const invite = await staffInviteSvc.createInvite(supabaseClient, {
      clinicId: "clinic-1",
      invitedByStaffId: "staff-1",
      name: "Dr. Nair",
      phone: "+919999999999",
      role: "doctor",
    });
    assert.equal(invite.status, "pending");
    assert.ok(invite.token && invite.token.length >= 32);
    assert.ok(new Date(invite.expiresAt).getTime() > Date.now());
  });

  test("rejects an invalid role", async () => {
    const supabaseClient = createTableStub({});
    await assert.rejects(
      () =>
        staffInviteSvc.createInvite(supabaseClient, { clinicId: "clinic-1", phone: "+919999999999", role: "owner" }),
      /Invalid role/,
    );
  });
});

describe("getInviteByToken", () => {
  test("rejects an already-accepted invite", async () => {
    const supabaseClient = createTableStub({
      StaffInvite: [
        {
          id: "invite-1",
          token: "tok1",
          status: "accepted",
          clinicId: "clinic-1",
          phone: "+919999999999",
          role: "doctor",
        },
      ],
    });
    await assert.rejects(() => staffInviteSvc.getInviteByToken(supabaseClient, "tok1"), /already been used/);
  });

  test("rejects an expired invite", async () => {
    const supabaseClient = createTableStub({
      StaffInvite: [
        {
          id: "invite-1",
          token: "tok1",
          status: "pending",
          clinicId: "clinic-1",
          phone: "+919999999999",
          role: "doctor",
          expiresAt: new Date(Date.now() - 1000).toISOString(),
        },
      ],
    });
    await assert.rejects(() => staffInviteSvc.getInviteByToken(supabaseClient, "tok1"), /expired/);
  });

  test("rejects an unknown token", async () => {
    const supabaseClient = createTableStub({ StaffInvite: [] });
    await assert.rejects(() => staffInviteSvc.getInviteByToken(supabaseClient, "nope"), /not found/i);
  });
});

describe("acceptInvite", () => {
  test("creates the Staff row, sets Firebase claims, and marks the invite accepted", async () => {
    const supabaseClient = createTableStub({
      StaffInvite: [
        {
          id: "invite-1",
          token: "tok1",
          status: "pending",
          clinicId: "clinic-1",
          doctorId: null,
          name: "Anita",
          phone: "+919999999999",
          role: "receptionist",
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
        },
      ],
    });
    const firebaseAdminApp = makeFirebaseAdminStub();

    const staff = await staffInviteSvc.acceptInvite(supabaseClient, firebaseAdminApp, "tok1", {
      firebaseUid: "fb-uid-1",
      email: "anita@example.com",
    });

    assert.equal(staff.role, "receptionist");
    assert.equal(staff.clinicId, "clinic-1");
    assert.equal(staff.firebaseUid, "fb-uid-1");

    assert.equal(firebaseAdminApp.calls.length, 1);
    assert.equal(firebaseAdminApp.calls[0].uid, "fb-uid-1");
    assert.equal(firebaseAdminApp.calls[0].claims.role, "receptionist");

    const { data: invite } = await supabaseClient.from("StaffInvite").eq("id", "invite-1").maybeSingle();
    assert.equal(invite.status, "accepted");
  });

  test("a second accept attempt on the same token fails", async () => {
    const supabaseClient = createTableStub({
      StaffInvite: [
        {
          id: "invite-1",
          token: "tok1",
          status: "pending",
          clinicId: "clinic-1",
          name: "Anita",
          phone: "+919999999999",
          role: "receptionist",
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
        },
      ],
    });
    const firebaseAdminApp = makeFirebaseAdminStub();
    await staffInviteSvc.acceptInvite(supabaseClient, firebaseAdminApp, "tok1", { firebaseUid: "fb-uid-1" });
    await assert.rejects(
      () => staffInviteSvc.acceptInvite(supabaseClient, firebaseAdminApp, "tok1", { firebaseUid: "fb-uid-2" }),
      /already been used/,
    );
  });
});
