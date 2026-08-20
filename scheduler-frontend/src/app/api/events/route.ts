import { NextRequest, NextResponse } from "next/server";
import { getDoctorRows, getDoctorRow, defaultClinicId } from "@/lib/supabase-server";
import { getCalendarEvents, createEvent, NettuError } from "@/lib/nettu";
import type { CalEvent } from "@/lib/types";

export const dynamic = "force-dynamic";

function eventTitle(metadata: Record<string, unknown> | undefined, busy: boolean): string {
  if (typeof metadata?.title === "string" && metadata.title) return metadata.title;
  if (metadata?.appointmentSource) return "Appointment";
  return busy ? "Busy" : "Available";
}

// GET /api/events?start=<epochMs>&end=<epochMs>&clinicId=...
// Fans out to every doctor's nettu calendar in the clinic and returns a flat, doctor-tagged list.
export async function GET(req: NextRequest) {
  const start = Number(req.nextUrl.searchParams.get("start"));
  const end = Number(req.nextUrl.searchParams.get("end"));
  const clinicId = req.nextUrl.searchParams.get("clinicId") ?? defaultClinicId();

  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) {
    return NextResponse.json({ error: "start and end (epoch ms) are required" }, { status: 400 });
  }

  try {
    const doctors = (await getDoctorRows(clinicId)).filter(
      (d) => d.schedulerDoctorId && d.schedulerCalendarId,
    );

    const perDoctor = await Promise.all(
      doctors.map(async (d): Promise<CalEvent[]> => {
        try {
          const events = await getCalendarEvents(d.schedulerCalendarId!, start, end);
          return events.map((e) => ({
            id: e.id,
            doctorId: d.id,
            title: eventTitle(e.metadata, e.busy ?? true),
            startTs: e.startTs,
            endTs: e.startTs + e.duration,
            busy: e.busy ?? true,
          }));
        } catch (err) {
          // One broken calendar must not take down the whole board.
          console.error(`Failed to load events for doctor ${d.id}:`, err);
          return [];
        }
      }),
    );

    return NextResponse.json({ events: perDoctor.flat() });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

// POST /api/events
// body: { doctorId, startTs, durationMs, title?, busy? }
export async function POST(req: NextRequest) {
  let body: {
    doctorId?: string;
    startTs?: number;
    durationMs?: number;
    title?: string;
    busy?: boolean;
  };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const { doctorId, startTs, durationMs, title, busy } = body;
  if (!doctorId || !Number.isFinite(startTs) || !Number.isFinite(durationMs)) {
    return NextResponse.json(
      { error: "doctorId, startTs and durationMs are required" },
      { status: 422 },
    );
  }

  try {
    const doctor = await getDoctorRow(doctorId);
    if (!doctor) return NextResponse.json({ error: "Doctor not found" }, { status: 404 });
    if (!doctor.schedulerDoctorId || !doctor.schedulerCalendarId) {
      return NextResponse.json(
        { error: "Doctor has no calendar configured — run the setup script" },
        { status: 422 },
      );
    }

    const event = await createEvent(doctor.schedulerDoctorId, {
      calendarId: doctor.schedulerCalendarId,
      startTs: startTs!,
      durationMs: durationMs!,
      busy: busy ?? true,
      metadata: { title: title ?? "Appointment", source: "scheduler-ui" },
    });

    const result: CalEvent = {
      id: event.id,
      doctorId,
      title: title ?? "Appointment",
      startTs: event.startTs,
      endTs: event.startTs + event.duration,
      busy: event.busy ?? true,
    };
    return NextResponse.json({ event: result }, { status: 201 });
  } catch (err) {
    if (err instanceof NettuError) {
      return NextResponse.json({ error: err.message }, { status: err.status || 502 });
    }
    const message = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
