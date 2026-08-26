const { test, describe } = require("node:test");
const assert = require("node:assert/strict");

const staffInviteSvc = require("../../src/services/staff-invite-service");
const { createTableStub } = require("../helpers/supabase-table-stub");
const { hashToken } = staffInviteSvc;

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

  test("stores the token hashed, not in plaintext — the caller still gets the raw one back once", async () => {
    const supabaseClient = createTableStub({});
    const invite = await staffInviteSvc.createInvite(supabaseClient, {
      clinicId: "clinic-1", phone: "+919999999999", role: "receptionist",
    });
    const stored = supabaseClient._tables.StaffInvite.find((r) => r.id === invite.id);
    assert.notEqual(stored.token, invite.token, "the stored row should hold a hash, not the raw token returned to the caller");
    assert.equal(stored.token, hashToken(invite.token));
    // And the hash actually resolves via the normal lookup path — proves
    // the returned raw token is the real, usable credential.
    const resolved = await staffInviteSvc.getInviteByToken(supabaseClient, invite.token);
    assert.equal(resolved.id, invite.id);
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
          token: hashToken("tok1"),
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
          token: hashToken("tok1"),
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

  // The short-code lookup flow (getInviteByShortCode) hands back the
  // invite's own id in place of the now-hashed token — this is what makes
  // that substitution actually work end to end.
  test("also resolves by the invite's raw id, not just its hashed token", async () => {
    const supabaseClient = createTableStub({
      StaffInvite: [{ id: "invite-by-id-1", token: hashToken("tok-unrelated"), status: "pending", clinicId: "clinic-1", phone: "+919999999999", role: "doctor", expiresAt: new Date(Date.now() + 60_000).toISOString() }],
    });
    const resolved = await staffInviteSvc.getInviteByToken(supabaseClient, "invite-by-id-1");
    assert.equal(resolved.id, "invite-by-id-1");
  });
});

describe("createInvite — solo-practice doctor limit", () => {
  test("rejects a second doctor invite when the solo clinic already has one active doctor", async () => {
    const supabaseClient = createTableStub({
      Clinic: [{ id: "clinic-1", practiceType: "solo" }],
      Doctor: [{ id: "doc-1", clinicId: "clinic-1", isActive: true }],
    });
    await assert.rejects(
      () => staffInviteSvc.createInvite(supabaseClient, { clinicId: "clinic-1", phone: "+919999999999", role: "doctor" }),
      /already has a doctor/,
    );
  });

  test("allows a doctor invite for a solo clinic with zero doctors (receptionist-founded)", async () => {
    const supabaseClient = createTableStub({
      Clinic: [{ id: "clinic-1", practiceType: "solo" }],
      Doctor: [],
    });
    const invite = await staffInviteSvc.createInvite(supabaseClient, {
      clinicId: "clinic-1",
      phone: "+919999999999",
      role: "doctor",
    });
    assert.equal(invite.role, "doctor");
  });

  test("allows a second doctor invite for a polyclinic that already has one", async () => {
    const supabaseClient = createTableStub({
      Clinic: [{ id: "clinic-1", practiceType: "polyclinic" }],
      Doctor: [{ id: "doc-1", clinicId: "clinic-1", isActive: true }],
    });
    const invite = await staffInviteSvc.createInvite(supabaseClient, {
      clinicId: "clinic-1",
      phone: "+919999999999",
      role: "doctor",
    });
    assert.equal(invite.role, "doctor");
  });

  test("always generates a 6-character shortCode from the unambiguous alphabet", async () => {
    const supabaseClient = createTableStub({});
    const invite = await staffInviteSvc.createInvite(supabaseClient, {
      clinicId: "clinic-1",
      phone: "+919999999999",
      role: "receptionist",
    });
    assert.match(invite.shortCode, /^[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{6}$/);
  });
});

describe("acceptInvite", () => {
  test("creates the Staff row, sets Firebase claims, and marks the invite accepted", async () => {
    const supabaseClient = createTableStub({
      StaffInvite: [
        {
          id: "invite-1",
          token: hashToken("tok1"),
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

  test("creates a new Doctor row for a doctor invite with no pre-assigned doctorId", async () => {
    const supabaseClient = createTableStub({
      Clinic: [{ id: "clinic-1", practiceType: "solo" }],
      Doctor: [],
      StaffInvite: [
        {
          id: "invite-1",
          token: hashToken("tok-doc"),
          status: "pending",
          clinicId: "clinic-1",
          doctorId: null,
          name: "Dr. Kapoor",
          phone: "+919999999999",
          role: "doctor",
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
        },
      ],
    });
    const firebaseAdminApp = makeFirebaseAdminStub();

    const staff = await staffInviteSvc.acceptInvite(supabaseClient, firebaseAdminApp, "tok-doc", {
      firebaseUid: "fb-doc-1",
      email: "kapoor@example.com",
    });

    assert.equal(staff.role, "doctor");
    assert.ok(staff.doctorId, "expected a Doctor row to have been created and linked");
    const created = supabaseClient._tables.Doctor.find((d) => d.id === staff.doctorId);
    assert.equal(created.fullName, "Dr. Kapoor");
    assert.equal(created.clinicId, "clinic-1");

    const { data: staffRow } = await supabaseClient.from("Staff").eq("id", staff.id).maybeSingle();
    assert.equal(staffRow.onboardingCompleted, false);
    assert.equal(staffRow.onboardingStep, "you");
  });

  test("does not create a Doctor row when the invite already had one pre-assigned", async () => {
    const supabaseClient = createTableStub({
      Clinic: [{ id: "clinic-1", practiceType: "polyclinic" }],
      Doctor: [{ id: "doc-existing", clinicId: "clinic-1", isActive: true, fullName: "Dr. Existing" }],
      StaffInvite: [
        {
          id: "invite-2",
          token: hashToken("tok-preassigned"),
          status: "pending",
          clinicId: "clinic-1",
          doctorId: "doc-existing",
          name: "Dr. Existing",
          phone: "+919999999999",
          role: "doctor",
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
        },
      ],
    });
    const firebaseAdminApp = makeFirebaseAdminStub();

    const staff = await staffInviteSvc.acceptInvite(supabaseClient, firebaseAdminApp, "tok-preassigned", {
      firebaseUid: "fb-doc-2",
    });

    assert.equal(staff.doctorId, "doc-existing");
    assert.equal(supabaseClient._tables.Doctor.length, 1, "no extra Doctor row should have been created");
  });

  test("a second accept attempt on the same token fails", async () => {
    const supabaseClient = createTableStub({
      StaffInvite: [
        {
          id: "invite-1",
          token: hashToken("tok1"),
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

  // Regression test for a source-verified gap (QA audit, 2026-08-26/27):
  // acceptInvite used to mark the invite "accepted" only at the very end,
  // after already creating Staff (and possibly Doctor) rows — so two
  // different accounts racing the same invite link would both pass the
  // initial read and both create their own rows from one invite. The above
  // "second accept attempt" test only proves *sequential* reuse fails —
  // by the time call two starts, call one has already fully finished, so
  // it's caught by the ordinary already-accepted check, not by the new
  // atomic claim. This simulates the actual race: the initial read still
  // sees "pending" (so it doesn't reject early), but something else claims
  // the row before this request's own conditional UPDATE runs — proving
  // *that* write, not just the read, is what stops the second Staff row.
  test("does not create a Staff row if it loses the race to claim the invite", async () => {
    const supabaseClient = createTableStub({
      StaffInvite: [
        {
          id: "invite-race",
          token: hashToken("tok-race"),
          status: "pending",
          clinicId: "clinic-1",
          name: "Anita",
          phone: "+919999999999",
          role: "receptionist",
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
        },
      ],
    });
    const origFrom = supabaseClient.from.bind(supabaseClient);
    supabaseClient.from = function (name) {
      const chain = origFrom(name);
      if (name === "StaffInvite") {
        const origUpdate = chain.update.bind(chain);
        chain.update = function (patch) {
          // A concurrent request "wins" the moment ours starts its claim —
          // by the time our own WHERE status='pending' filter is evaluated,
          // the row no longer matches, exactly as Postgres would apply it.
          const row = supabaseClient._tables.StaffInvite.find((r) => r.id === "invite-race");
          if (row) row.status = "accepted";
          return origUpdate(patch);
        };
      }
      return chain;
    };
    const firebaseAdminApp = makeFirebaseAdminStub();

    await assert.rejects(
      () => staffInviteSvc.acceptInvite(supabaseClient, firebaseAdminApp, "tok-race", { firebaseUid: "fb-uid-race" }),
      (err) => {
        assert.equal(err.code, "INVITE_ALREADY_USED");
        return true;
      },
    );

    assert.equal(supabaseClient._tables.Staff?.length ?? 0, 0, "no Staff row should exist for the losing request");
    assert.equal(firebaseAdminApp.calls.length, 0, "Firebase claims must not be set for the losing request");
  });
});
