-- QA audit (2026-08-26/27) live-reproduced a real double-booking bug: two
-- concurrent POST /api/v1/public/appointments requests for the identical
-- doctor+timeslot both succeeded (two distinct Appointment rows, two
-- distinct nettu-scheduler events). Root cause: conflict protection only
-- ever existed inside nettu-scheduler's own slot-listing query — the write
-- path (nettuClient.createEvent, then this table's INSERT) had no atomic
-- check-and-reserve step anywhere. This index is the real backstop, at the
-- one layer that's actually transactional.
--
-- Only 'booked', 'tentative', and 'blocked' are slot-occupying statuses —
-- a cancelled/completed/no_show appointment must never prevent a new
-- booking at that same doctor+time. appointment-service.js's
-- persistAppointment() catches this constraint's violation (Postgres
-- 23505) and translates it into the existing SLOT_NOT_AVAILABLE error,
-- releasing the now-orphaned nettu hold the losing request already created.
CREATE UNIQUE INDEX IF NOT EXISTS appointment_doctor_active_slot_idx
  ON "Appointment" ("doctorId", "timeslot")
  WHERE "status" IN ('booked', 'tentative', 'blocked');
