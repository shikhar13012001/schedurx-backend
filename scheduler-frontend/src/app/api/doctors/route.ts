import { NextRequest, NextResponse } from "next/server";
import { getDoctorRows, getClinicRow, defaultClinicId } from "@/lib/supabase-server";
import type { Doctor } from "@/lib/types";

export const dynamic = "force-dynamic";

// GET /api/doctors?clinicId=...
export async function GET(req: NextRequest) {
  const clinicId = req.nextUrl.searchParams.get("clinicId") ?? defaultClinicId();

  try {
    const [rows, clinic] = await Promise.all([getDoctorRows(clinicId), getClinicRow(clinicId)]);

    if (!clinic) {
      return NextResponse.json({ error: `Clinic '${clinicId}' not found` }, { status: 404 });
    }

    const doctors: Doctor[] = rows.map((d) => ({
      id: d.id,
      fullName: d.fullName,
      specialty: d.specialty,
      feeInr: d.feeInr,
      timezone: d.timezone ?? clinic.timezone ?? "Asia/Kolkata",
      hasCalendar: Boolean(d.schedulerDoctorId && d.schedulerCalendarId),
    }));

    return NextResponse.json({
      doctors,
      clinic: { id: clinic.id, name: clinic.name, timezone: clinic.timezone },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
