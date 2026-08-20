# API Contract Baseline

Relocated from schedurx-ultravox-demo-api during the backend/demo split — see that
repo's own `docs/api-contract-baseline.md` for the webhook-side contract.

## Public Endpoints

- `GET /health` returns `{ ok, service, timestamp }`.
- `POST /tools/debug/echo` is intentionally unauthenticated and echoes received headers/body.
- `POST /tools/patients/identify` uses bearer auth (`TOOLS_API_KEY`) and returns a patient JSON object with `isNew`. `clinicId`/`phoneNumber` arrive as static body parameters baked in by the demo bridge at call-creation time.
- `POST /tools/patients/update` uses bearer auth and returns the patient JSON object.
- `POST /tools/doctors/list` uses bearer auth and returns `{ doctors }`.
- `POST /tools/doctors/select` uses bearer auth and returns a doctor JSON object or `{ error, availableDoctors }`.
- `POST /tools/appointments/book` uses bearer auth and returns `201` with the calendar tool envelope.
- `POST /tools/appointments/send-form` uses bearer auth and returns `{ delivered, note, formUrl }`.
- `POST /tools/calendar/slots` uses bearer auth and returns the calendar tool envelope.
- `POST /tools/calendar/reschedule` uses bearer auth and returns the calendar tool envelope.
- `POST /tools/calendar/cancel` uses bearer auth and returns the calendar tool envelope.
- `POST /internal/call-context/resolve` uses bearer auth (`INTERNAL_API_KEY`) and is called only by schedurx-ultravox-demo-api, never by Ultravox. Returns `{ clinicId, patientId, isNewPatient }`, all nullable — never throws.

## Error Model

- Tools auth failures return `401 { "error": "Unauthorized" }`.
- Calendar tool routes return structured tool errors: `{ "success": false, "error": { "code", "message", "details" } }`.
- `POST /tools/calendar/slots` intentionally uses `200` for `NO_SLOTS_AVAILABLE`.

See `docs/openapi.yaml` for the machine-readable baseline.
