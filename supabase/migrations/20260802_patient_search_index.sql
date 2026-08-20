-- Trigram search support for the patient search box (GET /api/v1/patients?q=).

CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE INDEX IF NOT EXISTS patient_full_name_trgm_idx
  ON "Patient" USING gin ("fullName" gin_trgm_ops);

CREATE INDEX IF NOT EXISTS patient_contact_number_trgm_idx
  ON "Patient" USING gin ("contactNumber" gin_trgm_ops);

-- Called via supabaseClient.rpc("search_patients", { p_clinic_id, p_query }) so the
-- app stays on @supabase/supabase-js only — no raw `pg` driver needed for ranked search.
CREATE OR REPLACE FUNCTION search_patients(p_clinic_id text, p_query text)
RETURNS SETOF "Patient"
LANGUAGE sql
STABLE
AS $$
  SELECT *
  FROM "Patient"
  WHERE "clinicId" = p_clinic_id
    AND (
      "fullName" ILIKE '%' || p_query || '%'
      OR "contactNumber" ILIKE '%' || p_query || '%'
    )
  ORDER BY GREATEST(
    similarity("fullName", p_query),
    similarity(coalesce("contactNumber", ''), p_query)
  ) DESC
  LIMIT 50;
$$;
