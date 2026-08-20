# Clinic Calendar Setup Guide

End-to-end guide for the calendar-integrated appointment system built on top of
[nettu-scheduler](https://github.com/fmeringdal/nettu-scheduler) (nittei).

---

## 1. Required environment variables

Add these to your `.env` file (see `.env.example` for the full template):

| Variable                    | Required       | Description                                  |
| --------------------------- | -------------- | -------------------------------------------- |
| `NETTU_BASE_URL`            | Yes (calendar) | URL of your running nettu-scheduler instance |
| `NETTU_API_KEY`             | Yes (calendar) | Account-level API key from nettu-scheduler   |
| `SUPABASE_URL`              | Yes            | Your Supabase project URL                    |
| `SUPABASE_SERVICE_ROLE_KEY` | Yes            | Supabase service-role key (bypasses RLS)     |

The server starts without `NETTU_BASE_URL`/`NETTU_API_KEY` and logs a warning.
Calendar routes (`/tools/calendar/*`) return an error until these are provided.

---

## 2. Run the database migration

Apply `supabase/migrations/20260612_clinic_doctor_calendar.sql` to your Supabase
project. It adds scheduler-ID columns to `Clinic`, `Doctor`, and `Appointment`,
and seeds the two POC doctors and the clinic row.

```bash
# Via Supabase CLI
supabase db push

# Or paste the file content into the Supabase dashboard SQL editor
```

---

## 3. Run the clinic calendar setup script

```bash
npm run setup:clinic-calendar
```

For verbose progress output (printed to stderr while JSON goes to stdout):

```bash
npm run setup:clinic-calendar:verbose
```

Redirect the JSON output to a file for review:

```bash
npm run setup:clinic-calendar > setup-output.json
```

### What the script does

1. Ensures `poc-clinic-001`, `doc-priya-001`, and `doc-rahul-001` exist in Supabase.
2. Creates (or reuses) a **nettu Service** for the clinic.
3. Configures the service with the clinic's booking-window constraints.
4. For each doctor:
   - Creates (or reuses) a **nettu User**, **Calendar**, and **Schedule**.
   - Adds the doctor to the clinic's service.
   - Persists the scheduler IDs to the `Doctor` table.
5. Outputs a structured JSON summary.

### How to safely re-run

The script is fully idempotent. Run it any number of times; it will:

- Skip creation if scheduler IDs are already stored in Supabase.
- Verify the stored IDs still exist in nettu; recreate if they do not.
- Always print the final state.

---

## 4. Sample setup output

```json
{
  "clinic": {
    "clinicId": "poc-clinic-001",
    "schedulerClinicId": "<nettu-service-uuid>",
    "serviceId": "<nettu-service-uuid>",
    "calendarId": null,
    "timezone": "Asia/Kolkata",
    "status": "active"
  },
  "doctors": [
    {
      "doctorId": "doc-priya-001",
      "doctorCalendarKey": "doc-priya-001_cal",
      "schedulerDoctorId": "<nettu-user-uuid>",
      "calendarId": "<nettu-calendar-uuid>",
      "clinicId": "poc-clinic-001",
      "serviceId": "<nettu-service-uuid>",
      "timezone": "Asia/Kolkata",
      "status": "active"
    },
    {
      "doctorId": "doc-rahul-001",
      "doctorCalendarKey": "doc-rahul-001_cal",
      "schedulerDoctorId": "<nettu-user-uuid>",
      "calendarId": "<nettu-calendar-uuid>",
      "clinicId": "poc-clinic-001",
      "serviceId": "<nettu-service-uuid>",
      "timezone": "Asia/Kolkata",
      "status": "active"
    }
  ]
}
```

---

## 5. Where to store the IDs

The script writes IDs directly to Supabase. These are the columns populated:

**Clinic table (`Clinic`):**

| Column                | Populated from                                  |
| --------------------- | ----------------------------------------------- |
| `schedulerServiceId`  | `clinic.schedulerClinicId` / `clinic.serviceId` |
| `schedulerCalendarId` | `null` (clinic has no direct calendar)          |
| `timezone`            | `clinic.timezone`                               |
| `status`              | `clinic.status`                                 |

**Doctor table (`Doctor`):**

| Column                | Populated from             |
| --------------------- | -------------------------- |
| `schedulerDoctorId`   | `doctor.schedulerDoctorId` |
| `schedulerCalendarId` | `doctor.calendarId`        |
| `doctorCalendarKey`   | `doctor.doctorCalendarKey` |

You do **not** need to manually copy any IDs; the script updates these columns.

---

## 6. How Ultravox calls each tool

All tools require a Bearer token (`TOOLS_API_KEY`) and receive `ultravoxCallId`
automatically from the Ultravox platform.

### get_doctor_available_slots

**When to use:** Patient asks when a doctor is available.

```json
POST /tools/calendar/slots
{
  "ultravoxCallId": "<auto>",
  "doctorId": "doc-priya-001",
  "dateRange": { "start": "2026-06-20", "end": "2026-06-27" },
  "timezone": "Asia/Kolkata"
}
```

**Success response:**

```json
{
  "success": true,
  "data": {
    "clinicId": "poc-clinic-001",
    "doctorId": "doc-priya-001",
    "timezone": "Asia/Kolkata",
    "startDate": "2026-06-20",
    "endDate": "2026-06-27",
    "slots": [
      {
        "slotId": "slot_1750399200000",
        "start": "2026-06-20T10:00:00+05:30",
        "end": "2026-06-20T10:30:00+05:30",
        "durationMinutes": 30,
        "doctorId": "doc-priya-001",
        "clinicId": "poc-clinic-001"
      }
    ]
  },
  "message": "Found 8 available slot(s)"
}
```

---

### book_calendar_appointment

**When to use:** Patient has confirmed a doctor and a specific time slot.

```json
POST /tools/calendar/book
{
  "ultravoxCallId": "<auto>",
  "doctorId": "doc-priya-001",
  "slotStart": "2026-06-20T10:00:00+05:30",
  "reason": "Fever and throat pain",
  "appointmentType": "consultation"
}
```

**Success response (201):**

```json
{
  "success": true,
  "data": {
    "appointment": {
      "appointmentId": "apt_<uuid>",
      "schedulerEventId": "<nettu-event-uuid>",
      "clinicId": "poc-clinic-001",
      "doctorId": "doc-priya-001",
      "start": "2026-06-20T10:00:00+05:30",
      "end": "2026-06-20T10:30:00+05:30",
      "status": "booked",
      "patient": { "name": null, "phone": "+919999999999" },
      "source": "ultravox"
    }
  },
  "message": "Appointment booked for 2026-06-20T10:00:00+05:30"
}
```

---

### reschedule_appointment

**When to use:** Patient wants to move an existing appointment.

```json
POST /tools/calendar/reschedule
{
  "ultravoxCallId": "<auto>",
  "appointmentId": "apt_<uuid>",
  "newStart": "2026-06-21T11:00:00+05:30",
  "reason": "Patient requested a later time"
}
```

**Success response:**

```json
{
  "success": true,
  "data": {
    "appointment": {
      "appointmentId": "apt_<uuid>",
      "status": "rescheduled",
      "oldStart": "2026-06-20T10:00:00+05:30",
      "oldEnd": null,
      "newStart": "2026-06-21T11:00:00+05:30",
      "newEnd": "2026-06-21T11:30:00+05:30"
    }
  },
  "message": "Appointment rescheduled to 2026-06-21T11:00:00+05:30"
}
```

---

### cancel_appointment

**When to use:** Patient confirms they want to cancel.

```json
POST /tools/calendar/cancel
{
  "ultravoxCallId": "<auto>",
  "appointmentId": "apt_<uuid>",
  "reason": "Patient is unavailable"
}
```

**Success response:**

```json
{
  "success": true,
  "data": {
    "appointment": {
      "appointmentId": "apt_<uuid>",
      "status": "cancelled",
      "clinicId": "poc-clinic-001",
      "doctorId": "doc-priya-001",
      "cancelledAt": "2026-06-12T12:00:00.000Z",
      "reason": "Patient is unavailable"
    }
  },
  "message": "Appointment cancelled"
}
```

---

## 7. Common error responses

All tool errors follow this shape:

```json
{
  "success": false,
  "error": {
    "code": "SLOT_NOT_AVAILABLE",
    "message": "The selected slot is no longer available.",
    "details": null
  }
}
```

| Code                            | HTTP | Meaning                                    |
| ------------------------------- | ---- | ------------------------------------------ |
| `CLINIC_NOT_FOUND`              | 404  | clinicId not in DB                         |
| `CLINIC_INACTIVE`               | 422  | Clinic exists but status ≠ active          |
| `DOCTOR_NOT_FOUND`              | 404  | doctorId not in DB                         |
| `DOCTOR_INACTIVE`               | 422  | Doctor isActive = false                    |
| `DOCTOR_NOT_IN_CLINIC`          | 422  | Doctor does not belong to requested clinic |
| `INVALID_DATE`                  | 400  | Unparseable date string                    |
| `INVALID_TIMEZONE`              | 400  | Unknown IANA timezone                      |
| `OUTSIDE_BOOKING_WINDOW`        | 422  | Date before min-notice or after max-window |
| `SLOT_NOT_AVAILABLE`            | 409  | Slot already booked or in the past         |
| `APPOINTMENT_NOT_FOUND`         | 404  | appointmentId not found                    |
| `APPOINTMENT_ALREADY_CANCELLED` | 422  | Cannot cancel a cancelled appointment      |
| `CANCELLATION_NOT_ALLOWED`      | 422  | Within the cancellation cutoff window      |
| `RESCHEDULE_NOT_ALLOWED`        | 422  | Within the reschedule cutoff window        |
| `SCHEDULER_API_ERROR`           | 502  | nettu-scheduler API call failed            |
| `DATABASE_ERROR`                | 500  | Supabase query failed                      |
| `VALIDATION_ERROR`              | 422  | Missing or invalid request field           |

---

## 8. Adding another doctor

1. Insert the doctor into the `Doctor` table with the correct `clinicId`.
2. Add the doctor's ID and calendar key to the `DOCTORS` array in
   `scripts/setup-clinic-calendars.js`.
3. Re-run `npm run setup:clinic-calendar` — only the new doctor will be created.

---

## 9. Adding another clinic

1. Insert the clinic into the `Clinic` table.
2. Add the clinic ID to the setup script (or write a separate script following
   the same `getOrCreateClinicService` / `getOrCreateDoctorCalendar` pattern).
3. Run the setup script for the new clinic.

---

## 10. Concurrency and double-booking prevention

- `bookAppointment` calls `nettuClient.createBooking()` which goes through the
  nettu-scheduler service endpoint. nettu-scheduler performs its own conflict
  check and returns **HTTP 409** if the slot is already taken.
- The route handler converts a 409 from nettu into a `SLOT_NOT_AVAILABLE` error
  returned to the agent before any Supabase record is created.
- In the unlikely event that the Supabase insert fails _after_ the nettu event
  was created, the error is logged with the nettu event ID so the orphaned event
  can be cleaned up manually.

---

## 11. Limitations and assumptions

- nettu-scheduler API shape is based on v0.x of the OSS project. Minor endpoint
  or response-field differences may require small adjustments to
  `src/services/nettu-client.js`.
- Timezone conversion uses the `Intl` API available in Node 18+. No extra
  dependencies are needed.
- Patient PII (name, symptoms) is stored only in the Supabase `Appointment` row,
  never in the nettu calendar event title. The event title is:
  `Appointment - Dr. Priya` (safe for calendar views).
- The `oldEnd` field in reschedule responses is currently `null` because the
  original `timeslot` field stores only `start`. It can be populated once the
  `Appointment` table stores `endTime` explicitly.
- The reschedule flow deletes the old nettu event and creates a new one rather
  than updating it, to ensure the new slot's conflict check runs in nettu.
