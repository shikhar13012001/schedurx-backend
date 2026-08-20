import { NextRequest, NextResponse } from "next/server";
import { updateEvent, deleteEvent, NettuError } from "@/lib/nettu";
import type { CalEvent } from "@/lib/types";

export const dynamic = "force-dynamic";

// PATCH /api/events/:eventId
// body: { doctorId, startTs?, durationMs?, busy?, title? }
export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ eventId: string }> },
) {
  const { eventId } = await params;

  let body: {
    doctorId?: string;
    startTs?: number;
    durationMs?: number;
    busy?: boolean;
    title?: string;
  };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  if (!body.doctorId) {
    return NextResponse.json({ error: "doctorId is required" }, { status: 422 });
  }

  try {
    const event = await updateEvent(eventId, {
      startTs: body.startTs,
      durationMs: body.durationMs,
      busy: body.busy,
      metadata:
        body.title !== undefined ? { title: body.title, source: "scheduler-ui" } : undefined,
    });

    const result: CalEvent = {
      id: event.id,
      doctorId: body.doctorId,
      title:
        body.title ??
        (typeof event.metadata?.title === "string" ? event.metadata.title : "Appointment"),
      startTs: event.startTs,
      endTs: event.startTs + event.duration,
      busy: event.busy ?? true,
    };
    return NextResponse.json({ event: result });
  } catch (err) {
    if (err instanceof NettuError) {
      return NextResponse.json({ error: err.message }, { status: err.status || 502 });
    }
    const message = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

// DELETE /api/events/:eventId
export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ eventId: string }> },
) {
  const { eventId } = await params;

  try {
    await deleteEvent(eventId);
    return NextResponse.json({ deleted: true });
  } catch (err) {
    if (err instanceof NettuError) {
      return NextResponse.json({ error: err.message }, { status: err.status || 502 });
    }
    const message = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
