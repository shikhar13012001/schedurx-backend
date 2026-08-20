#!/usr/bin/env node
// Idempotent clinic calendar setup script.
//
// Creates or verifies:
//   - A nettu-scheduler Service for poc-clinic-001
//   - A nettu User + Calendar + Schedule for each doctor (doc-priya-001, doc-rahul-001)
//   - Links each doctor to the clinic service
//   - Persists all scheduler IDs to Supabase (Clinic + Doctor tables)
//
// Running this script multiple times is safe — existing resources are reused.
//
// Usage:
//   npm run setup:clinic-calendar
//   npm run setup:clinic-calendar -- --verbose
//
// Required environment variables:
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, NETTU_BASE_URL, NETTU_API_KEY

require("dotenv").config();

const { createClient } = require("@supabase/supabase-js");
const { NettuClient } = require("../src/services/nettu-client");
const clinicSvc = require("../src/services/clinic-service");
const doctorSvc = require("../src/services/doctor-service");
const calendarSvc = require("../src/services/calendar-service");

// ─── Config ───────────────────────────────────────────────────────────────────

const VERBOSE = process.argv.includes("--verbose");

const CLINIC_ID = "poc-clinic-001";
const DOCTORS = [{ doctorId: "doc-priya-001" }, { doctorId: "doc-rahul-001" }];

function log(...args) {
  if (VERBOSE) console.error("[setup]", ...args);
}
function info(...args) {
  console.error("[setup]", ...args);
}

function requireEnv(name) {
  const val = process.env[name];
  if (!val) {
    console.error(`[setup] ERROR: environment variable ${name} is required`);
    process.exit(1);
  }
  return val;
}

// ─── Step helpers ─────────────────────────────────────────────────────────────

// Ensure the Clinic row exists in Supabase (the SQL migration seeds it, but this is a fallback).
async function ensureClinicRow(supabase) {
  const { data, error } = await supabase.from("Clinic").select("*").eq("id", CLINIC_ID).maybeSingle();

  if (error) throw new Error(`DB error checking clinic: ${error.message}`);

  if (!data) {
    info(`Clinic '${CLINIC_ID}' not found in DB — inserting seed row`);
    const { error: insertErr } = await supabase.from("Clinic").insert({
      id: CLINIC_ID,
      name: "POC Clinic",
      phone: "+919000000000",
      timezone: "Asia/Kolkata",
      status: "active",
    });
    if (insertErr) throw new Error(`DB error inserting clinic: ${insertErr.message}`);
  }
}

// Ensure each Doctor row exists in Supabase.
async function ensureDoctorRows(supabase) {
  for (const { doctorId } of DOCTORS) {
    const { data, error } = await supabase.from("Doctor").select("id").eq("id", doctorId).maybeSingle();

    if (error) throw new Error(`DB error checking doctor ${doctorId}: ${error.message}`);

    if (!data) {
      const name = doctorId === "doc-priya-001" ? "Dr. Priya" : "Dr. Rahul";
      info(`Doctor '${doctorId}' not found — inserting seed row`);
      const { error: insertErr } = await supabase.from("Doctor").insert({
        id: doctorId,
        clinicId: CLINIC_ID,
        fullName: name,
        feeInr: 500,
        isActive: true,
      });
      if (insertErr) throw new Error(`DB error inserting doctor ${doctorId}: ${insertErr.message}`);
    }
  }
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function run() {
  const supabaseUrl = requireEnv("SUPABASE_URL");
  const supabaseKey = requireEnv("SUPABASE_SERVICE_ROLE_KEY");
  const nettuBaseUrl = requireEnv("NETTU_BASE_URL");
  const nettuApiKey = requireEnv("NETTU_API_KEY");

  const supabase = createClient(supabaseUrl, supabaseKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const consoleLogger = VERBOSE ? { debug: log, info, warn: info, error: info } : null;

  const nettu = new NettuClient({ baseUrl: nettuBaseUrl, apiKey: nettuApiKey, logger: consoleLogger });

  info("Ensuring Supabase rows exist…");
  await ensureClinicRow(supabase);
  await ensureDoctorRows(supabase);

  // ── 1. Clinic service ──────────────────────────────────────────────────────
  info("Setting up clinic service in nettu-scheduler…");
  const { service, isNew: isNewService } = await calendarSvc.getOrCreateClinicService(
    nettu,
    supabase,
    CLINIC_ID,
    consoleLogger,
  );

  info(`Clinic service ${isNewService ? "created" : "already existed"}: ${service.id}`);

  // Re-fetch clinic to get persisted IDs.
  const clinic = await clinicSvc.getClinic(supabase, CLINIC_ID);
  const clinicRules = clinicSvc.getSchedulingRules(clinic);

  // ── 2. Doctor calendars ───────────────────────────────────────────────────
  const doctorResults = [];

  for (const { doctorId } of DOCTORS) {
    info(`Setting up calendar for doctor '${doctorId}'…`);

    const result = await calendarSvc.getOrCreateDoctorCalendar(nettu, supabase, doctorId, CLINIC_ID, consoleLogger);

    info(
      `Doctor '${doctorId}' ${result.isNew ? "calendar created" : "calendar already existed"}: ${result.calendar.id}`,
    );

    doctorResults.push({ doctorId, result });
  }

  // ── 3. Reload final state from Supabase ───────────────────────────────────
  const { data: freshClinic } = await supabase.from("Clinic").select("*").eq("id", CLINIC_ID).maybeSingle();

  const doctorOutput = [];
  for (const { doctorId, result } of doctorResults) {
    const { data: freshDoctor } = await supabase.from("Doctor").select("*").eq("id", doctorId).maybeSingle();
    doctorOutput.push({
      doctorId,
      schedulerDoctorId: freshDoctor?.schedulerDoctorId ?? result.nettuUser.id,
      calendarId: freshDoctor?.schedulerCalendarId ?? result.calendar.id,
      clinicId: CLINIC_ID,
      serviceId: freshClinic?.schedulerServiceId ?? service.id,
      timezone: result.doctorRules.timezone,
      status: freshDoctor?.isActive ? "active" : "inactive",
    });
  }

  const output = {
    clinic: {
      clinicId: CLINIC_ID,
      serviceId: freshClinic?.schedulerServiceId ?? service.id,
      timezone: clinicRules.timezone,
      status: freshClinic?.status ?? "active",
    },
    doctors: doctorOutput,
  };

  // Print only the JSON to stdout (suitable for piping / CI capture).
  console.log(JSON.stringify(output, null, 2));
}

run().catch((err) => {
  console.error("[setup] FATAL:", err.message);
  if (VERBOSE) console.error(err.stack);
  process.exit(1);
});
