"use client";

import { CalendarClock, Clock3, Plus, Stethoscope } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Calendar } from "@/components/ui/calendar";
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import type { ClinicInfo, DoctorWithColor } from "@/hooks/use-scheduler";

interface SidebarProps {
  clinics: ClinicInfo[];
  clinicId: string | null;
  onClinicChange: (clinicId: string) => void;
  clinic: ClinicInfo | null;
  doctors: DoctorWithColor[];
  visibleDoctors: Set<string>;
  loading: boolean;
  anchor: Date;
  onAnchorChange: (date: Date) => void;
  onToggleDoctor: (doctorId: string) => void;
  onNewEvent: () => void;
  onEditSchedule: (doctor: DoctorWithColor) => void;
}

export function Sidebar({
  clinics,
  clinicId,
  onClinicChange,
  clinic,
  doctors,
  visibleDoctors,
  loading,
  anchor,
  onAnchorChange,
  onToggleDoctor,
  onNewEvent,
  onEditSchedule,
}: SidebarProps) {
  return (
    <aside className="flex max-h-[42svh] w-full shrink-0 flex-col gap-4 overflow-y-auto rounded-lg border bg-sidebar/90 p-3 text-sidebar-foreground shadow-[0_18px_45px_-34px_rgba(15,23,42,0.9)] backdrop-blur lg:max-h-none lg:w-72">
      <div className="rounded-md border border-sidebar-border bg-card/95 p-3 shadow-xs">
        {clinics.length > 1 ? (
          <>
            <label
              htmlFor="clinic-select"
              className="mb-1 block text-xs font-semibold uppercase tracking-wide text-muted-foreground"
            >
              Clinic
            </label>
            <select
              id="clinic-select"
              className="h-9 w-full rounded-lg border border-input bg-background px-2.5 text-sm font-semibold outline-none transition-colors focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 dark:bg-input/30"
              value={clinicId ?? ""}
              onChange={(e) => onClinicChange(e.target.value)}
            >
              {clinics.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </>
        ) : (
          <div className="flex items-center gap-2">
            <div className="flex size-8 items-center justify-center rounded-md bg-primary text-primary-foreground">
              <Stethoscope className="size-4" aria-hidden="true" />
            </div>
            <h1 className="min-w-0 truncate text-lg font-semibold leading-tight tracking-normal">
              {clinic?.name ?? "Clinic Scheduler"}
            </h1>
          </div>
        )}
        {clinic?.timezone && (
          <p className="mt-2 inline-flex items-center gap-1 rounded-md bg-muted px-2 py-1 text-[11px] font-semibold leading-none text-muted-foreground">
            <Clock3 className="size-3" aria-hidden="true" />
            {clinic.timezone}
          </p>
        )}
      </div>

      <Button onClick={onNewEvent} className="h-10 justify-start gap-2 text-sm font-semibold shadow-sm">
        <Plus className="h-4 w-4" />
        New appointment
      </Button>

      <Calendar
        mode="single"
        selected={anchor}
        onSelect={(d) => d && onAnchorChange(d)}
        weekStartsOn={1}
        className="rounded-lg border bg-card shadow-xs"
      />

      <Separator />

      <div className="min-h-0 flex-1">
        <div className="mb-2 flex items-center justify-between">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            Doctors
          </h3>
          {!loading && doctors.length > 0 && (
            <span className="rounded-md bg-muted px-1.5 py-0.5 font-mono text-[11px] font-medium leading-none text-muted-foreground">
              {visibleDoctors.size}/{doctors.length}
            </span>
          )}
        </div>
        {loading ? (
          <div className="space-y-2">
            <Skeleton className="h-10 w-full" />
            <Skeleton className="h-10 w-full" />
          </div>
        ) : (
          <div className="space-y-1.5">
            {doctors.map((doctor) => {
              const visible = visibleDoctors.has(doctor.id);
              return (
                <div
                  key={doctor.id}
                  className={cn(
                    "group flex items-center gap-2 rounded-md border border-transparent bg-card/75 px-2 py-2.5 transition-colors hover:border-sidebar-border hover:bg-card hover:shadow-xs",
                    !visible && "opacity-45",
                  )}
                >
                  <button
                    type="button"
                    className="flex min-w-0 flex-1 items-center gap-2 rounded-sm text-left outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
                    onClick={() => onToggleDoctor(doctor.id)}
                    title={visible ? "Hide calendar" : "Show calendar"}
                    aria-pressed={visible}
                  >
                    <span
                      className="h-3 w-3 shrink-0 rounded-full border border-white/60 shadow-sm"
                      style={{ backgroundColor: doctor.color }}
                    />
                    <span className="min-w-0">
                      <span className="block truncate text-sm font-semibold leading-tight">
                        {doctor.fullName}
                      </span>
                      {doctor.specialty && (
                        <span className="block truncate text-[12px] leading-snug text-muted-foreground">
                          {doctor.specialty}
                        </span>
                      )}
                    </span>
                  </button>

                  <Tooltip>
                    <TooltipTrigger
                      render={
                        <Button
                          variant="ghost"
                          size="icon-sm"
                          className="opacity-100 transition-opacity sm:opacity-0 sm:group-hover:opacity-100 sm:focus-visible:opacity-100"
                          onClick={() => onEditSchedule(doctor)}
                          disabled={!doctor.hasCalendar}
                          aria-label={`Edit working hours for ${doctor.fullName}`}
                        >
                          <CalendarClock className="h-4 w-4" />
                        </Button>
                      }
                    />
                    <TooltipContent side="right">Working hours</TooltipContent>
                  </Tooltip>
                </div>
              );
            })}
            {doctors.length === 0 && (
              <p className="rounded-md border border-dashed bg-card/70 px-3 py-4 text-sm text-muted-foreground">
                No active doctors found.
              </p>
            )}
          </div>
        )}
      </div>
    </aside>
  );
}
