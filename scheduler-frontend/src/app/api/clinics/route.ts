import { NextResponse } from "next/server";
import { getClinicRows, defaultClinicId } from "@/lib/supabase-server";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const rows = await getClinicRows();
    return NextResponse.json({
      clinics: rows.map((c) => ({ id: c.id, name: c.name, timezone: c.timezone })),
      defaultClinicId: defaultClinicId(),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
