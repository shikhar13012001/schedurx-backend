"use client";

import { useMemo, useState } from "react";
import { addDays } from "date-fns";
import { AlertCircle } from "lucide-react";
import { TooltipProvider } from "@/components/ui/tooltip";
import { useScheduler, type DoctorWithColor } from "@/hooks/use-scheduler";
import { CalendarHeader } from "./calendar-header";
import { Sidebar } from "./sidebar";
import { WeekView } from "./week-view";
import { MonthView } from "./month-view";
import { EventDialog, type EventDialogState } from "./event-dialog";
import { ScheduleDialog } from "./schedule-dialog";
import type { CalEvent } from "@/lib/types";

export function Scheduler() {
  const s = useScheduler();

  const [eventDialog, setEventDialog] = useState<EventDialogState>(null);
  const [scheduleDoctor, setScheduleDoctor] = useState<DoctorWithColor | null>(null);

  const days = useMemo(() => {
    const result: Date[] = [];
    let d = s.range.start;
    while (d <= s.range.end) {
      result.push(d);
      d = addDays(d, 1);
    }
    return result;
  }, [s.range.start, s.range.end]);

  const openCreate = (start?: Date) => {
    const base = start ?? (() => {
      const d = new Date(s.anchor);
      d.setHours(10, 0, 0, 0);
      return d;
    })();
    setEventDialog({ mode: "create", start: base });
  };

  const openEdit = (event: CalEvent) => setEventDialog({ mode: "edit", event });

  return (
    <TooltipProvider delay={300}>
      <div className="flex h-[100svh] flex-col gap-3 overflow-hidden bg-[radial-gradient(circle_at_top_left,color-mix(in_oklch,var(--primary),transparent_88%),transparent_32rem),var(--background)] p-3 text-foreground lg:flex-row lg:gap-4 lg:p-4">
        <Sidebar
          clinics={s.clinics}
          clinicId={s.clinicId}
          onClinicChange={s.setClinicId}
          clinic={s.clinic}
          doctors={s.doctors}
          visibleDoctors={s.visibleDoctors}
          loading={s.loadingDoctors}
          anchor={s.anchor}
          onAnchorChange={(d) => s.setAnchor(d)}
          onToggleDoctor={s.toggleDoctor}
          onNewEvent={() => openCreate()}
          onEditSchedule={setScheduleDoctor}
        />

        <main className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden rounded-lg border bg-card/95 shadow-[0_18px_45px_-34px_rgba(15,23,42,0.9)] backdrop-blur">
          <CalendarHeader
            view={s.view}
            anchor={s.anchor}
            loading={s.loadingEvents}
            onViewChange={s.setView}
            onAnchorChange={s.setAnchor}
            onRefresh={s.refresh}
          />

          {s.error && (
            <div
              role="alert"
              className="mx-3 mb-3 flex items-start gap-2 rounded-md border border-destructive/35 bg-destructive/10 px-3 py-2 text-sm text-destructive lg:mx-4"
            >
              <AlertCircle className="mt-0.5 size-4 shrink-0" />
              <span>{s.error}</span>
            </div>
          )}

          <div className="min-h-0 flex-1 px-2 pb-2 sm:px-3 sm:pb-3 lg:px-4 lg:pb-4">
            {s.view === "month" ? (
              <MonthView
                days={days}
                anchor={s.anchor}
                events={s.events}
                doctors={s.doctors}
                onDayClick={(day) => {
                  s.setAnchor(day);
                  s.setView("day");
                }}
                onEventClick={openEdit}
              />
            ) : (
              <WeekView
                days={days}
                events={s.events}
                doctors={s.doctors}
                onSlotClick={(start) => openCreate(start)}
                onEventClick={openEdit}
              />
            )}
          </div>
        </main>

        <EventDialog
          state={eventDialog}
          doctors={s.doctors}
          onClose={() => setEventDialog(null)}
          onCreate={s.createEvent}
          onUpdate={s.updateEvent}
          onDelete={s.deleteEvent}
        />

        <ScheduleDialog doctor={scheduleDoctor} onClose={() => setScheduleDoctor(null)} />
      </div>
    </TooltipProvider>
  );
}
