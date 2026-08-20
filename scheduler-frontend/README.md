# Scheduler Frontend

A standalone calendar UI for the clinic's [nettu-scheduler](https://github.com/fmeringdal/nettu-scheduler) instance. Built with Next.js (App Router) + shadcn/ui + Tailwind. Deployed separately from the voice API.

## What it does

- **Day / Week / Month** calendar views for all clinic doctors, color-coded per doctor
- **Click an empty slot** to create an appointment (doctor, title, time, duration, busy flag)
- **Click an event** to edit or delete it
- **Toggle doctors** in the sidebar to show/hide their calendars
- **Edit working hours** per doctor (the nettu Schedule that drives the booking engine used by the voice agent)

## Architecture

The browser never talks to nettu or Supabase directly. Next.js route handlers proxy everything server-side, so `NETTU_API_KEY` and the Supabase service-role key stay on the server:

```
Browser ──> /api/doctors                      ──> Supabase (Doctor/Clinic tables)
       ──> /api/events?start&end              ──> nettu GET /user/calendar/{calId}/events (per doctor)
       ──> POST /api/events                   ──> nettu POST /user/{userId}/events
       ──> PATCH|DELETE /api/events/{id}      ──> nettu PUT|DELETE /user/events/{id}
       ──> GET|PUT /api/doctors/{id}/schedule ──> nettu GET|PUT /user/schedule/{scheduleId}
```

Doctor → nettu ID mapping (`schedulerDoctorId`, `schedulerCalendarId`) lives in the Supabase `Doctor` table, written by the voice API's `setup:clinic-calendar` script. A doctor's schedule ID is resolved through the clinic service membership (`service.users[].availability.id`) because nettu has no list-schedules-for-user endpoint.

## Setup

```bash
npm install
cp .env.example .env.local   # fill in real values
npm run dev                  # http://localhost:3000
```

Required env vars (all server-side only):

| Variable | Purpose |
| --- | --- |
| `NETTU_BASE_URL` | URL of the nettu-scheduler instance |
| `NETTU_API_KEY` | nettu account API key (`x-api-key`) |
| `SUPABASE_URL` | Supabase project URL |
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase service-role key |
| `CLINIC_ID` | Clinic whose doctors are shown (default `poc-clinic-001`) |

## Deploy

Any Node host works. On Vercel: set the project **Root Directory** to `scheduler-frontend`, add the five env vars, deploy. There is no auth on this UI — put it behind your own auth/VPN before exposing it publicly.

## Notes

- Times are rendered in the browser's local timezone; the clinic timezone (`Asia/Kolkata`) is shown in the sidebar.
- Events created here are `busy` by default, so they block voice-agent booking slots immediately.
- The week/day grid covers 07:00–21:00 with 30-minute click snapping.
