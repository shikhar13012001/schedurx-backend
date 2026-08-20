"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { format, isSameDay, isToday } from "date-fns";
import { cn } from "@/lib/utils";
import type { CalEvent } from "@/lib/types";
import type { DoctorWithColor } from "@/hooks/use-scheduler";

const HOUR_START = 7;
const HOUR_END = 21;
const HOUR_PX = 64;
const GRID_HEIGHT = (HOUR_END - HOUR_START) * HOUR_PX;
const SNAP_MINUTES = 30;

interface Positioned {
  event: CalEvent;
  col: number;
  cols: number;
}

function layoutEvents(events: CalEvent[]): Positioned[] {
  const sorted = [...events].sort((a, b) => a.startTs - b.startTs || a.endTs - b.endTs);
  const result: Positioned[] = [];

  let cluster: CalEvent[] = [];
  let clusterEnd = -Infinity;

  const flush = () => {
    if (cluster.length === 0) return;
    const colEnds: number[] = [];
    const assigned: Array<{ event: CalEvent; col: number }> = [];
    for (const e of cluster) {
      let col = colEnds.findIndex((end) => end <= e.startTs);
      if (col === -1) {
        col = colEnds.length;
        colEnds.push(e.endTs);
      } else {
        colEnds[col] = e.endTs;
      }
      assigned.push({ event: e, col });
    }
    const cols = colEnds.length;
    for (const a of assigned) result.push({ ...a, cols });
    cluster = [];
    clusterEnd = -Infinity;
  };

  for (const e of sorted) {
    if (e.startTs >= clusterEnd) flush();
    cluster.push(e);
    clusterEnd = Math.max(clusterEnd, e.endTs);
  }
  flush();

  return result;
}

function minutesIntoGrid(ts: number, day: Date): number {
  const d = new Date(ts);
  if (!isSameDay(d, day)) {
    return d.getTime() < day.getTime() ? 0 : (HOUR_END - HOUR_START) * 60;
  }
  return d.getHours() * 60 + d.getMinutes() - HOUR_START * 60;
}

interface WeekViewProps {
  days: Date[];
  events: CalEvent[];
  doctors: DoctorWithColor[];
  onSlotClick: (start: Date) => void;
  onEventClick: (event: CalEvent) => void;
}

export function WeekView({ days, events, doctors, onSlotClick, onEventClick }: WeekViewProps) {
  const doctorById = useMemo(
    () => new Map(doctors.map((d) => [d.id, d])),
    [doctors],
  );

  const scrollRef = useRef<HTMLDivElement>(null);
  const [nowTick, setNowTick] = useState(() => Date.now());

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: (9 - HOUR_START) * HOUR_PX - 16 });
    const t = setInterval(() => setNowTick(Date.now()), 60_000);
    return () => clearInterval(t);
  }, []);

  const hours = Array.from({ length: HOUR_END - HOUR_START }, (_, i) => HOUR_START + i);

  const eventsByDay = useMemo(() => {
    return days.map((day) =>
      layoutEvents(
        events.filter((e) => {
          const start = new Date(e.startTs);
          return isSameDay(start, day);
        }),
      ),
    );
  }, [days, events]);

  const handleColumnClick = (day: Date, e: React.MouseEvent<HTMLDivElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const y = e.clientY - rect.top;
    const rawMinutes = HOUR_START * 60 + (y / HOUR_PX) * 60;
    const snapped = Math.floor(rawMinutes / SNAP_MINUTES) * SNAP_MINUTES;
    const start = new Date(day);
    start.setHours(Math.floor(snapped / 60), snapped % 60, 0, 0);
    onSlotClick(start);
  };

  const now = new Date(nowTick);
  const nowOffset = now.getHours() * 60 + now.getMinutes() - HOUR_START * 60;
  const showNowLine = nowOffset >= 0 && nowOffset <= (HOUR_END - HOUR_START) * 60;

  return (
    <div className="flex h-full flex-col overflow-hidden rounded-lg border bg-card shadow-sm">
      <div
        className="grid border-b bg-muted/45"
        style={{ gridTemplateColumns: `64px repeat(${days.length}, 1fr)` }}
      >
        <div />
        {days.map((day) => (
          <div
            key={day.toISOString()}
            className={cn(
              "border-l px-2 py-2 text-center",
              isToday(day) && "bg-primary/8",
            )}
          >
            <div className="text-[11px] font-semibold uppercase leading-none text-muted-foreground">
              {format(day, "EEE")}
            </div>
            <div
              className={cn(
                "mx-auto mt-1 flex h-7 w-7 items-center justify-center rounded-full font-mono text-sm font-semibold leading-none",
                isToday(day) && "bg-primary text-primary-foreground",
              )}
            >
              {format(day, "d")}
            </div>
          </div>
        ))}
      </div>

      <div ref={scrollRef} className="flex-1 overflow-y-auto">
        <div
          className="relative grid"
          style={{
            gridTemplateColumns: `64px repeat(${days.length}, 1fr)`,
            height: GRID_HEIGHT,
          }}
        >
          <div className="relative">
            {hours.map((h) => (
              <div
                key={h}
                className="absolute right-2 -translate-y-1/2 font-mono text-[11px] leading-none text-muted-foreground"
                style={{ top: (h - HOUR_START) * HOUR_PX }}
              >
                {h === HOUR_START ? "" : format(new Date(2000, 0, 1, h), "h a")}
              </div>
            ))}
          </div>

          {days.map((day, dayIdx) => (
            <div
              key={day.toISOString()}
              className={cn(
                "relative cursor-pointer border-l",
                isToday(day) && "bg-primary/[0.03]",
              )}
              onClick={(e) => handleColumnClick(day, e)}
            >
              {hours.map((h) => (
                <div
                  key={h}
                  className="pointer-events-none absolute inset-x-0 border-t border-border/55"
                  style={{ top: (h - HOUR_START) * HOUR_PX }}
                />
              ))}

              {isToday(day) && showNowLine && (
                <div
                  className="pointer-events-none absolute inset-x-0 z-20 flex items-center"
                  style={{ top: (nowOffset / 60) * HOUR_PX }}
                >
                  <div className="h-2 w-2 -translate-x-1 rounded-full bg-red-500" />
                  <div className="h-px flex-1 bg-red-500" />
                </div>
              )}

              {eventsByDay[dayIdx].map(({ event, col, cols }) => {
                const doctor = doctorById.get(event.doctorId);
                const startMin = Math.max(0, minutesIntoGrid(event.startTs, day));
                const endMin = Math.min(
                  (HOUR_END - HOUR_START) * 60,
                  minutesIntoGrid(event.endTs, day) || startMin + 30,
                );
                const top = (startMin / 60) * HOUR_PX;
                const height = Math.max(20, ((endMin - startMin) / 60) * HOUR_PX);
                const width = 100 / cols;

                return (
                  <button
                    key={event.id}
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      onEventClick(event);
                    }}
                    className="absolute z-10 overflow-hidden rounded-md border border-white/25 px-1.5 py-0.5 text-left text-white shadow-sm outline-none transition-all hover:-translate-y-px hover:shadow-md focus-visible:ring-2 focus-visible:ring-ring/70"
                    aria-label={`${event.title}, ${format(new Date(event.startTs), "h:mm a")}, ${doctor?.fullName ?? event.doctorId}`}
                    style={{
                      top,
                      height,
                      left: `calc(${col * width}% + 2px)`,
                      width: `calc(${width}% - 4px)`,
                      backgroundColor: doctor?.color ?? "#64748b",
                    }}
                  >
                    <div className="truncate text-[11px] font-semibold leading-[1.05]">
                      {event.title}
                    </div>
                    {height > 36 && (
                      <div className="truncate font-mono text-[10px] leading-tight opacity-90">
                        {format(new Date(event.startTs), "h:mm a")} -{" "}
                        {doctor?.fullName ?? event.doctorId}
                      </div>
                    )}
                  </button>
                );
              })}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
