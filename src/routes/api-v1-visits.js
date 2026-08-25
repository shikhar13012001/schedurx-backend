const { Router } = require("express");
const { ok, fail } = require("../lib/response-envelope");
const visitSvc = require("../services/visit-service");
const openaiSvc = require("../services/openai-service");

function createApiV1VisitsRouter(supabaseClient, openaiClient, elevenLabsClient) {
  const router = Router();

  // GET /api/v1/visits/scribe-token — mints a 15-minute single-use
  // ElevenLabs token so the browser can open its own real-time Scribe
  // transcription session directly (see now-serving.tsx's ambient-capture
  // mode). Mounted before "/:id" routes so "scribe-token" is never
  // swallowed as an :id param.
  router.get("/scribe-token", async (req, res) => {
    if (!elevenLabsClient) return fail(res, 503, "TRANSCRIPTION_NOT_CONFIGURED", "Real-time transcription is not configured for this deployment");
    try {
      const token = await elevenLabsClient.mintRealtimeScribeToken();
      return ok(res, { token });
    } catch (err) {
      req.log?.error({ err }, "[api-v1:visits] scribe-token failed");
      return fail(res, err.statusCode ?? 500, err.code ?? "INTERNAL_ERROR", err.message);
    }
  });

  router.get("/", async (req, res) => {
    const { patientId } = req.query;
    if (!patientId) return fail(res, 422, "MISSING_FIELDS", "patientId query param is required");

    try {
      const visits = await visitSvc.listVisitsForPatient(supabaseClient, req.staff.clinicId, patientId);
      return ok(res, { visits });
    } catch (err) {
      req.log?.error({ err }, "[api-v1:visits] list failed");
      return fail(res, err.statusCode ?? 500, err.code ?? "INTERNAL_ERROR", err.message);
    }
  });

  router.post("/", async (req, res) => {
    try {
      const visit = await visitSvc.createVisit(supabaseClient, { ...req.body, clinicId: req.staff.clinicId });
      return res.status(201).json({ success: true, data: { visit }, message: null });
    } catch (err) {
      req.log?.error({ err }, "[api-v1:visits] create failed");
      return fail(res, err.statusCode ?? 500, err.code ?? "INTERNAL_ERROR", err.message);
    }
  });

  router.patch("/:id", async (req, res) => {
    try {
      const visit = await visitSvc.updateVisit(supabaseClient, req.staff.clinicId, req.params.id, req.body ?? {});
      return ok(res, { visit });
    } catch (err) {
      req.log?.error({ err }, "[api-v1:visits] update failed");
      return fail(res, err.statusCode ?? 500, err.code ?? "INTERNAL_ERROR", err.message);
    }
  });

  // Returns a Supabase Storage signed upload URL — the browser PUTs the file
  // bytes directly to Storage, never through this server.
  router.post("/:id/upload-url", async (req, res) => {
    const { fileName, contentType } = req.body ?? {};
    if (!fileName) return fail(res, 422, "MISSING_FIELDS", "fileName is required");

    try {
      const result = await visitSvc.createUploadUrl(supabaseClient, req.staff.clinicId, req.params.id, {
        fileName,
        contentType,
      });
      return ok(res, result);
    } catch (err) {
      req.log?.error({ err }, "[api-v1:visits] upload-url failed");
      return fail(res, err.statusCode ?? 500, err.code ?? "INTERNAL_ERROR", err.message);
    }
  });

  // Called after a successful direct-to-storage upload to record it on the Visit.
  router.post("/:id/attachments", async (req, res) => {
    const { path, type } = req.body ?? {};
    try {
      const visit = await visitSvc.addAttachment(supabaseClient, req.staff.clinicId, req.params.id, { path, type });
      return res.status(201).json({ success: true, data: { visit }, message: null });
    } catch (err) {
      req.log?.error({ err }, "[api-v1:visits] add attachment failed");
      return fail(res, err.statusCode ?? 500, err.code ?? "INTERNAL_ERROR", err.message);
    }
  });

  // POST /api/v1/visits/:id/recap — turns a doctor's short recap (typed or
  // recorded) into a structured clinical note, saved onto the visit. Backs
  // both the manual "Recap" capture mode and ambient capture (the frontend
  // decides when to call this; this route doesn't distinguish the two).
  router.post("/:id/recap", async (req, res) => {
    if (!openaiClient) return fail(res, 503, "AI_NOT_CONFIGURED", "AI recap is not configured for this deployment");

    const { text, audioBase64, filename } = req.body ?? {};
    if (!text && !audioBase64) return fail(res, 422, "MISSING_FIELDS", "text or audioBase64 is required");

    try {
      const rawText = audioBase64
        ? await openaiSvc.transcribeAudio(openaiClient, Buffer.from(audioBase64, "base64"), filename)
        : text;
      if (!rawText?.trim()) return fail(res, 422, "EMPTY_RECAP", "Nothing to work with — the recording was silent");

      const note = await openaiSvc.generateVisitNote(openaiClient, rawText);
      const visit = await visitSvc.updateVisit(supabaseClient, req.staff.clinicId, req.params.id, { notes: note });
      return ok(res, { visit, transcript: rawText });
    } catch (err) {
      req.log?.error({ err }, "[api-v1:visits] recap failed");
      return fail(res, err.statusCode ?? 500, err.code ?? "INTERNAL_ERROR", err.message);
    }
  });

  // POST /api/v1/visits/:id/suggest — live, doctor-facing decision-support
  // prompt during ambient capture (see openai-service.js's suggestDuringConsult
  // for the full scope/safety framing). Called periodically by the frontend
  // as committed transcript segments accumulate, not on every keystroke.
  // Doesn't write anything to the Visit — purely advisory, nothing persisted.
  router.post("/:id/suggest", async (req, res) => {
    if (!openaiClient) return fail(res, 503, "AI_NOT_CONFIGURED", "AI suggestions are not configured for this deployment");

    const { transcript } = req.body ?? {};
    if (!transcript?.trim()) return fail(res, 422, "MISSING_FIELDS", "transcript is required");

    try {
      const suggestion = await openaiSvc.suggestDuringConsult(openaiClient, transcript);
      return ok(res, { suggestion });
    } catch (err) {
      req.log?.error({ err }, "[api-v1:visits] suggest failed");
      return fail(res, err.statusCode ?? 500, err.code ?? "INTERNAL_ERROR", err.message);
    }
  });

  // Short-lived read URL for a private-bucket attachment — scoped to paths
  // this clinic actually owns (path is namespaced clinicId/visitId/...).
  router.get("/:id/attachments/read-url", async (req, res) => {
    const { path } = req.query;
    const expectedPrefix = `${req.staff.clinicId}/${req.params.id}/`;
    if (!path || !String(path).startsWith(expectedPrefix)) {
      return fail(res, 403, "FORBIDDEN", "path does not belong to this clinic/visit");
    }

    try {
      const url = await visitSvc.createReadUrl(supabaseClient, path);
      return ok(res, { url });
    } catch (err) {
      req.log?.error({ err }, "[api-v1:visits] read-url failed");
      return fail(res, err.statusCode ?? 500, err.code ?? "INTERNAL_ERROR", err.message);
    }
  });

  return router;
}

module.exports = { createApiV1VisitsRouter };
