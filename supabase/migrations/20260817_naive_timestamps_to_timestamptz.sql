-- A handful of tables predating this repo (Clinic, Doctor, Patient, Appointment
-- — see docs/live-schema-baseline.md) still use `timestamp without time zone`
-- columns, unlike every table this repo created fresh (`timestamptz`
-- throughout). This repo's app code has always written genuine UTC instants
-- into those naive columns (every writer uses `new Date().toISOString()`, and
-- the production server runs in UTC), so the stored digits are correct UTC —
-- just missing the tz marker, which caused a client-side display bug: a
-- marker-less timestamp gets reinterpreted as the *viewer's* local time
-- instead of UTC (see src/lib/dates.js for the application-level band-aid
-- this migration makes unnecessary once applied).
--
-- Safe to run: `... AT TIME ZONE 'UTC'` reinterprets the existing naive
-- digits as UTC (correct, matching how they were always written) while
-- converting the column to a timezone-aware type. Guarded so re-running
-- (or running against a database where this already happened) is a no-op.
--
-- No CLI migration runner in this repo — apply via `psql` or the Supabase
-- SQL Editor, per README.md's "Database migrations" section.

DO $$
DECLARE
  col RECORD;
  naive_cols TEXT[][] := ARRAY[
    ['Appointment', 'timeslot'],
    ['Appointment', 'createdAt'],
    ['Appointment', 'updatedAt'],
    ['Appointment', 'cancelledAt'],
    ['Appointment', 'rescheduledAt'],
    ['Appointment', 'oldStart'],
    ['Appointment', 'oldEnd'],
    ['Clinic', 'createdAt'],
    ['Clinic', 'updatedAt'],
    ['Doctor', 'createdAt'],
    ['Doctor', 'updatedAt'],
    ['Patient', 'createdAt']
  ];
  pair TEXT[];
BEGIN
  FOREACH pair SLICE 1 IN ARRAY naive_cols LOOP
    SELECT table_name, column_name, data_type INTO col
    FROM information_schema.columns
    WHERE table_name = pair[1] AND column_name = pair[2];

    IF FOUND AND col.data_type = 'timestamp without time zone' THEN
      EXECUTE format(
        'ALTER TABLE %I ALTER COLUMN %I TYPE timestamptz USING %I AT TIME ZONE ''UTC''',
        pair[1], pair[2], pair[2]
      );
      RAISE NOTICE 'Converted %.% to timestamptz', pair[1], pair[2];
    END IF;
  END LOOP;
END $$;
