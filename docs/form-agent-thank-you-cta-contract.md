# Thank-you page CTAs — contract for schedurx-form-agent

Phase 7 of the WhatsApp-on-plans + Stripe billing plan. `schedurx-form-agent`
is a separate repo not available to the backend session that built this —
this is the handoff: what it needs to call, and what to render.

## What changed on the backend

- `Clinic.googleReviewUrl` — a clinic can now set a Google review link
  (Profile → Practice in the dashboard).
- New endpoint: **`GET /api/v1/public/appointments/:id/comms-links?clinicId=`**
  (unauthenticated, same capability model as the existing
  `GET /api/v1/public/appointments/:id` — id + clinicId together).

Response shape:

```json
{
  "success": true,
  "data": {
    "reviewUrl": "https://g.page/r/nirmaya-clinic/review",
    "textCommsUrl": "https://wa.me/14155238886?text=BOOKING%20apt_abc123"
  },
  "message": null
}
```

Either field can be `null` — a clinic that hasn't set a review link, or has
no WhatsApp sender configured, still gets a valid 200 response with the
other field (or both) null. Render the CTA only when its URL is non-null;
don't treat a null as an error.

## What to build on the thank-you page

Two buttons/links, populated from the response above:

1. **"Leave us a review"** → `reviewUrl`, opened in a new tab.
2. **"Message us about this booking"** → `textCommsUrl`. This is a
   `wa.me` click-to-chat link that pre-fills the message `BOOKING
   <appointmentId>` — tapping it opens WhatsApp with that text ready to
   send. When the patient sends it, the backend resolves straight to a
   booking-scoped conversation Thread tied to this specific appointment
   (verified against the patient's own phone number server-side before
   attaching — a mismatched phone silently falls back to normal
   phone-based resolution instead of erroring, so this is safe to link to
   without any client-side validation).

Call the endpoint once, right when the thank-you page loads (it already has
`clinicId` and the appointment `id` from the booking flow / URL), and cache
the result for that page view — no polling needed, these URLs don't change
per-request.

## Not in scope for this contract

- No new auth is introduced — this endpoint is public, matching every other
  `/api/v1/public/*` route this app already calls.
- The existing `GET /api/v1/public/appointments/:id` confirmation-page
  endpoint is unchanged — this is an additive, separate endpoint, not a
  replacement.
