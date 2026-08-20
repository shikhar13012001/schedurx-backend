// Working-hours (nettu Schedule) read/update for a doctor.
//
// nettu has no "list schedules for user" endpoint, so the schedule ID is
// resolved through the clinic Service: service.users[].availability.id.

import { NextRequest, NextResponse } from "next/server";
import { getDoctorRow, getClinicRow } from "@/lib/supabase-server";
import {
  getService,
  getSchedule,
  updateSchedule,
  NettuError,
  type NettuScheduleRule,
} from "@/lib/nettu";
import { WEEKDAYS, type DaySchedule, type DoctorSchedule, type Weekday } from "@/lib/types";

export const dynamic = "force-dynamic";

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

function toHHMM(t: { hours: number; minutes: number }): string {
  return `${pad(t.hours)}:${pad(t.minutes)}`;
}

function parseHHMM(hhmm: string): { hours: number; minutes: number } | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm);
  if (!m) return null;
  const hours = Number(m[1]);
  const minutes = Number(m[2]);
  if (hours > 23 || minutes > 59) return null;
  return { hours, minutes };
}

// nettu rules (one per enabled weekday) → editor rows (all 7 days).
function rulesToDays(rules: NettuScheduleRule[]): DaySchedule[] {
  const byDay = new Map<string, NettuScheduleRule>();
  for (const rule of rules) {
    if (rule.variant?.type === "WDay") byDay.set(rule.variant.value, rule);
  }
  return WEEKDAYS.map((day) => {
    const rule = byDay.get(day);
    const interval = rule?.intervals?.[0];
    return {
      day,
      enabled: Boolean(interval),
      start: interval ? toHHMM(interval.start) : "09:00",
      end: interval ? toHHMM(interval.end) : "18:00",
    };
  });
}

function daysToRules(days: DaySchedule[]): NettuScheduleRule[] | { error: string } {
  const rules: NettuScheduleRule[] = [];
  for (const d of days) {
    if (!d.enabled) continue;
    const start = parseHHMM(d.start);
    const end = parseHHMM(d.end);
    if (!start || !end) return { error: `Invalid time for ${d.day}` };
    if (start.hours * 60 + start.minutes >= end.hours * 60 + end.minutes) {
      return { error: `${d.day}: start must be before end` };
    }
    rules.push({ variant: { type: "WDay", value: d.day }, intervals: [{ start, end }] });
  }
  if (rules.length === 0) return { error: "At least one working day is required" };
  return rules;
}

async function resolveScheduleId(doctorId: string): Promise<
  { scheduleId: string } | { error: string; status: number }
> {
  const doctor = await getDoctorRow(doctorId);
  if (!doctor) return { error: "Doctor not found", status: 404 };
  if (!doctor.schedulerDoctorId) return { error: "Doctor has no calendar configured", status: 422 };

  const clinic = await getClinicRow(doctor.clinicId);
  if (!clinic?.schedulerServiceId) return { error: "Clinic service not configured", status: 422 };

  const service = await getService(clinic.schedulerServiceId);
  if (!service) return { error: "Clinic service not found in scheduler", status: 502 };

  const member = service.users.find((u) => u.userId === doctor.schedulerDoctorId);
  const scheduleId = member?.availability?.id;
  if (!scheduleId) {
    return { error: "Doctor has no schedule attached to the clinic service", status: 422 };
  }
  return { scheduleId };
}

// GET /api/doctors/:doctorId/schedule
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ doctorId: string }> },
) {
  const { doctorId } = await params;
  try {
    const resolved = await resolveScheduleId(doctorId);
    if ("error" in resolved) {
      return NextResponse.json({ error: resolved.error }, { status: resolved.status });
    }

    const schedule = await getSchedule(resolved.scheduleId);
    const result: DoctorSchedule = {
      scheduleId: schedule.id,
      timezone: schedule.timezone,
      days: rulesToDays(schedule.rules ?? []),
    };
    return NextResponse.json({ schedule: result });
  } catch (err) {
    if (err instanceof NettuError) {
      return NextResponse.json({ error: err.message }, { status: err.status || 502 });
    }
    const message = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

// PUT /api/doctors/:doctorId/schedule
// body: { days: DaySchedule[] }
export async function PUT(
  req: NextRequest,
  { params }: { params: Promise<{ doctorId: string }> },
) {
  const { doctorId } = await params;

  let body: { days?: DaySchedule[] };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  if (!Array.isArray(body.days)) {
    return NextResponse.json({ error: "days array is required" }, { status: 422 });
  }
  const validDays = body.days.filter((d) => WEEKDAYS.includes(d.day as Weekday));

  const rules = daysToRules(validDays);
  if ("error" in rules) {
    return NextResponse.json({ error: rules.error }, { status: 422 });
  }

  try {
    const resolved = await resolveScheduleId(doctorId);
    if ("error" in resolved) {
      return NextResponse.json({ error: resolved.error }, { status: resolved.status });
    }

    const schedule = await updateSchedule(resolved.scheduleId, { rules });
    const result: DoctorSchedule = {
      scheduleId: schedule.id,
      timezone: schedule.timezone,
      days: rulesToDays(schedule.rules ?? []),
    };
    return NextResponse.json({ schedule: result });
  } catch (err) {
    if (err instanceof NettuError) {
      return NextResponse.json({ error: err.message }, { status: err.status || 502 });
    }
    const message = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
