// Server-side Supabase access (service role). Only import from route handlers.
//
// FOLLOW-UP: this duplicates queries already in ../../../src/services/{clinic,doctor}-service.js
// and table-service.js (moved here from schedurx-ultravox-demo-api alongside this app).
// Consolidating them is out of scope for the migration that relocated this file.

import { createClient, type SupabaseClient } from "@supabase/supabase-js";

let client: SupabaseClient | null = null;

function getSupabase(): SupabaseClient {
  if (!client) {
    const url = process.env.SUPABASE_URL;
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!url || !key) throw new Error("SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set");
    client = createClient(url, key, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
  }
  return client;
}

export function defaultClinicId(): string {
  return process.env.CLINIC_ID ?? "poc-clinic-001";
}

export interface DoctorRow {
  id: string;
  clinicId: string;
  fullName: string;
  specialty: string | null;
  feeInr: number;
  timezone: string | null;
  schedulerDoctorId: string | null;
  schedulerCalendarId: string | null;
}

const DOCTOR_COLUMNS =
  "id, clinicId, fullName, specialty, feeInr, timezone, schedulerDoctorId, schedulerCalendarId";

export async function getDoctorRows(clinicId: string): Promise<DoctorRow[]> {
  const { data, error } = await getSupabase()
    .from("Doctor")
    .select(DOCTOR_COLUMNS)
    .eq("clinicId", clinicId)
    .eq("isActive", true)
    .order("fullName");
  if (error) throw new Error(`DB error listing doctors: ${error.message}`);
  return data ?? [];
}

export async function getDoctorRow(doctorId: string): Promise<DoctorRow | null> {
  const { data, error } = await getSupabase()
    .from("Doctor")
    .select(DOCTOR_COLUMNS)
    .eq("id", doctorId)
    .maybeSingle();
  if (error) throw new Error(`DB error fetching doctor: ${error.message}`);
  return data ?? null;
}

export interface ClinicRow {
  id: string;
  name: string;
  timezone: string;
  status: string | null;
  schedulerServiceId: string | null;
}

const CLINIC_COLUMNS = "id, name, timezone, status, schedulerServiceId";

export async function getClinicRows(): Promise<ClinicRow[]> {
  const { data, error } = await getSupabase()
    .from("Clinic")
    .select(CLINIC_COLUMNS)
    .order("name");
  if (error) throw new Error(`DB error listing clinics: ${error.message}`);
  return (data ?? []).filter((c) => !c.status || c.status === "active");
}

export async function getClinicRow(clinicId: string): Promise<ClinicRow | null> {
  const { data, error } = await getSupabase()
    .from("Clinic")
    .select(CLINIC_COLUMNS)
    .eq("id", clinicId)
    .maybeSingle();
  if (error) throw new Error(`DB error fetching clinic: ${error.message}`);
  return data ?? null;
}
