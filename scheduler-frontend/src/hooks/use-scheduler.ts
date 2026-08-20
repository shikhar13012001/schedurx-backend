"use client";

// Central state for the scheduler UI: doctors, visible range, events, mutations.

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  startOfDay,
  endOfDay,
  startOfWeek,
  endOfWeek,
  startOfMonth,
  endOfMonth,
} from "date-fns";
import type { CalEvent, Doctor } from "@/lib/types";
import { doctorColor } from "@/lib/colors";

export type ViewMode = "day" | "week" | "month";

export interface DoctorWithColor extends Doctor {
  color: string;
}

export interface ClinicInfo {
  id: string;
  name: string;
  timezone: string;
}

function computeRange(view: ViewMode, anchor: Date): { start: Date; end: Date } {
  if (view === "day") return { start: startOfDay(anchor), end: endOfDay(anchor) };
  if (view === "week") {
    return {
      start: startOfWeek(anchor, { weekStartsOn: 1 }),
      end: endOfWeek(anchor, { weekStartsOn: 1 }),
    };
  }
  // month view renders full leading/trailing weeks
  return {
    start: startOfWeek(startOfMonth(anchor), { weekStartsOn: 1 }),
    end: endOfWeek(endOfMonth(anchor), { weekStartsOn: 1 }),
  };
}

async function apiJson<T>(input: string, init?: RequestInit): Promise<T> {
  const res = await fetch(input, init);
  const json = await res.json().catch(() => null);
  if (!res.ok) {
    throw new Error((json as { error?: string } | null)?.error ?? `HTTP ${res.status}`);
  }
  return json as T;
}

export function useScheduler() {
  const [clinics, setClinics] = useState<ClinicInfo[]>([]);
  const [clinicId, setClinicId] = useState<string | null>(null);
  const [doctors, setDoctors] = useState<DoctorWithColor[]>([]);
  const [clinic, setClinic] = useState<ClinicInfo | null>(null);
  const [visibleDoctors, setVisibleDoctors] = useState<Set<string>>(new Set());
  const [view, setView] = useState<ViewMode>("week");
  const [anchor, setAnchor] = useState<Date>(new Date());
  const [events, setEvents] = useState<CalEvent[]>([]);
  const [loadingDoctors, setLoadingDoctors] = useState(true);
  const [loadingEvents, setLoadingEvents] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);

  const range = useMemo(() => computeRange(view, anchor), [view, anchor]);

  // Load the clinic list once; select the server-configured default.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const data = await apiJson<{ clinics: ClinicInfo[]; defaultClinicId: string }>(
          "/api/clinics",
        );
        if (cancelled) return;
        setClinics(data.clinics);
        const initial =
          data.clinics.find((c) => c.id === data.defaultClinicId)?.id ??
          data.clinics[0]?.id ??
          null;
        setClinicId(initial);
        if (!initial) setError("No clinics found");
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : "Failed to load clinics");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Load doctors whenever the selected clinic changes.
  useEffect(() => {
    if (!clinicId) return;
    let cancelled = false;
    (async () => {
      try {
        await Promise.resolve();
        if (cancelled) return;
        setLoadingDoctors(true);
        setEvents([]);
        const data = await apiJson<{ doctors: Doctor[]; clinic: ClinicInfo | null }>(
          `/api/doctors?clinicId=${encodeURIComponent(clinicId)}`,
        );
        if (cancelled) return;
        const withColors = data.doctors.map((d, i) => ({ ...d, color: doctorColor(i) }));
        setDoctors(withColors);
        setClinic(data.clinic);
        setVisibleDoctors(new Set(withColors.map((d) => d.id)));
        setError(null);
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : "Failed to load doctors");
      } finally {
        if (!cancelled) setLoadingDoctors(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [clinicId]);

  // Load events whenever the clinic or visible range changes (or after a mutation).
  useEffect(() => {
    if (!clinicId) return;
    let cancelled = false;
    (async () => {
      try {
        await Promise.resolve();
        if (cancelled) return;
        setLoadingEvents(true);
        const data = await apiJson<{ events: CalEvent[] }>(
          `/api/events?start=${range.start.getTime()}&end=${range.end.getTime()}&clinicId=${encodeURIComponent(clinicId)}`,
        );
        if (!cancelled) {
          setEvents(data.events);
          setError(null);
        }
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : "Failed to load events");
      } finally {
        if (!cancelled) setLoadingEvents(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [clinicId, range.start, range.end, refreshKey]);

  const refresh = useCallback(() => setRefreshKey((k) => k + 1), []);

  const toggleDoctor = useCallback((doctorId: string) => {
    setVisibleDoctors((prev) => {
      const next = new Set(prev);
      if (next.has(doctorId)) next.delete(doctorId);
      else next.add(doctorId);
      return next;
    });
  }, []);

  // ─── Mutations ──────────────────────────────────────────────────────────────

  const createEvent = useCallback(
    async (opts: { doctorId: string; startTs: number; durationMs: number; title: string; busy: boolean }) => {
      await apiJson("/api/events", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(opts),
      });
      refresh();
    },
    [refresh],
  );

  const updateEvent = useCallback(
    async (
      eventId: string,
      opts: { doctorId: string; startTs: number; durationMs: number; title: string; busy: boolean },
    ) => {
      await apiJson(`/api/events/${eventId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(opts),
      });
      refresh();
    },
    [refresh],
  );

  const deleteEvent = useCallback(
    async (eventId: string, doctorId: string) => {
      await apiJson(`/api/events/${eventId}?doctorId=${encodeURIComponent(doctorId)}`, {
        method: "DELETE",
      });
      refresh();
    },
    [refresh],
  );

  const visibleEvents = useMemo(
    () => events.filter((e) => visibleDoctors.has(e.doctorId)),
    [events, visibleDoctors],
  );

  return {
    clinics,
    clinicId,
    setClinicId,
    doctors,
    clinic,
    visibleDoctors,
    toggleDoctor,
    view,
    setView,
    anchor,
    setAnchor,
    range,
    events: visibleEvents,
    loadingDoctors,
    loadingEvents,
    error,
    refresh,
    createEvent,
    updateEvent,
    deleteEvent,
  };
}

export type SchedulerState = ReturnType<typeof useScheduler>;
