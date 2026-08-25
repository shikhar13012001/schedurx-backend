const { test, describe } = require("node:test");
const assert = require("node:assert/strict");

const visitSvc = require("../../src/services/visit-service");
const { createTableStub } = require("../helpers/supabase-table-stub");

describe("listVisitsForPatient — ordering", () => {
  test("same-day visits are ordered by createdAt, not left in arbitrary DB order", async () => {
    const supabaseClient = createTableStub({
      Visit: [
        { id: "v1", clinicId: "clinic-1", patientId: "pat-1", visitDate: "2026-08-26", createdAt: "2026-08-26T09:00:00.000Z" },
        { id: "v2", clinicId: "clinic-1", patientId: "pat-1", visitDate: "2026-08-26", createdAt: "2026-08-26T11:30:00.000Z" },
        { id: "v3", clinicId: "clinic-1", patientId: "pat-1", visitDate: "2026-08-26", createdAt: "2026-08-26T10:15:00.000Z" },
      ],
    });
    const visits = await visitSvc.listVisitsForPatient(supabaseClient, "clinic-1", "pat-1");
    assert.deepEqual(visits.map((v) => v.id), ["v2", "v3", "v1"]);
  });

  test("visitDate still sorts across different days, most recent first", async () => {
    const supabaseClient = createTableStub({
      Visit: [
        { id: "old", clinicId: "clinic-1", patientId: "pat-1", visitDate: "2026-08-20", createdAt: "2026-08-20T09:00:00.000Z" },
        { id: "new", clinicId: "clinic-1", patientId: "pat-1", visitDate: "2026-08-26", createdAt: "2026-08-26T09:00:00.000Z" },
      ],
    });
    const visits = await visitSvc.listVisitsForPatient(supabaseClient, "clinic-1", "pat-1");
    assert.deepEqual(visits.map((v) => v.id), ["new", "old"]);
  });
});

describe("addAttachment — audio type", () => {
  test("accepts an 'audio' attachment (a saved ambient-capture/recap recording)", async () => {
    const supabaseClient = createTableStub({
      Visit: [{ id: "v1", clinicId: "clinic-1", rxAttachments: [] }],
    });
    const visit = await visitSvc.addAttachment(supabaseClient, "clinic-1", "v1", { path: "clinic-1/v1/recording.webm", type: "audio" });
    assert.deepEqual(
      visit.rxAttachments.map((a) => a.type),
      ["audio"]
    );
  });

  test("still rejects an attachment type outside photo/digital/audio", async () => {
    const supabaseClient = createTableStub({ Visit: [{ id: "v1", clinicId: "clinic-1", rxAttachments: [] }] });
    await assert.rejects(
      () => visitSvc.addAttachment(supabaseClient, "clinic-1", "v1", { path: "clinic-1/v1/x", type: "video" }),
      /MISSING_FIELDS|valid type/
    );
  });
});
