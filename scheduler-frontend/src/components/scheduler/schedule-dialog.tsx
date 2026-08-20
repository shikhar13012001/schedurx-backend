"use client";

// Working-hours editor for a doctor's nettu Schedule.

import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";
import type { DaySchedule, DoctorSchedule } from "@/lib/types";
import type { DoctorWithColor } from "@/hooks/use-scheduler";

const DAY_LABELS: Record<string, string> = {
  Mon: "Monday",
  Tue: "Tuesday",
  Wed: "Wednesday",
  Thu: "Thursday",
  Fri: "Friday",
  Sat: "Saturday",
  Sun: "Sunday",
};

interface ScheduleDialogProps {
  doctor: DoctorWithColor | null;
  onClose: () => void;
}

export function ScheduleDialog({ doctor, onClose }: ScheduleDialogProps) {
  const [days, setDays] = useState<DaySchedule[]>([]);
  const [timezone, setTimezone] = useState("");
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    if (!doctor) return;
    let cancelled = false;
    (async () => {
      try {
        await Promise.resolve();
        if (cancelled) return;
        setLoading(true);
        setLoadError(null);
        const res = await fetch(`/api/doctors/${doctor.id}/schedule`);
        const json = await res.json().catch(() => null);
        if (!res.ok) throw new Error(json?.error ?? `HTTP ${res.status}`);
        if (cancelled) return;
        const schedule: DoctorSchedule = json.schedule;
        setDays(schedule.days);
        setTimezone(schedule.timezone);
      } catch (err) {
        if (!cancelled) {
          setLoadError(err instanceof Error ? err.message : "Failed to load schedule");
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [doctor]);

  if (!doctor) return null;

  const patchDay = (day: string, patch: Partial<DaySchedule>) => {
    setDays((prev) => prev.map((d) => (d.day === day ? { ...d, ...patch } : d)));
  };

  const handleSave = async () => {
    setSaving(true);
    try {
      const res = await fetch(`/api/doctors/${doctor.id}/schedule`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ days }),
      });
      const json = await res.json().catch(() => null);
      if (!res.ok) throw new Error(json?.error ?? `HTTP ${res.status}`);
      toast.success(`Working hours updated for ${doctor.fullName}`);
      onClose();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to save schedule");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <span
              className="h-3 w-3 rounded-full"
              style={{ backgroundColor: doctor.color }}
            />
            Working hours - {doctor.fullName}
          </DialogTitle>
          <DialogDescription className="flex items-center gap-2">
            Availability used by the booking engine.
            {timezone && <Badge variant="secondary">{timezone}</Badge>}
          </DialogDescription>
        </DialogHeader>

        {loading ? (
          <div className="space-y-2 py-2">
            {Array.from({ length: 7 }).map((_, i) => (
              <Skeleton key={i} className="h-10 w-full" />
            ))}
          </div>
        ) : loadError ? (
          <p className="py-4 text-sm text-destructive">{loadError}</p>
        ) : (
          <div className="space-y-1.5 py-2">
            {days.map((d) => (
              <div
                key={d.day}
                className={cn(
                  "flex items-center gap-3 rounded-md border px-3 py-2",
                  !d.enabled && "bg-muted/40",
                )}
              >
                <Switch
                  checked={d.enabled}
                  onCheckedChange={(checked) => patchDay(d.day, { enabled: checked })}
                />
                <span
                  className={cn(
                    "w-24 text-sm font-medium",
                    !d.enabled && "text-muted-foreground",
                  )}
                >
                  {DAY_LABELS[d.day]}
                </span>
                <div className="ml-auto flex items-center gap-2">
                  <Input
                    type="time"
                    className="h-8 w-28"
                    value={d.start}
                    disabled={!d.enabled}
                    onChange={(e) => patchDay(d.day, { start: e.target.value })}
                  />
                  <span className="text-xs text-muted-foreground">to</span>
                  <Input
                    type="time"
                    className="h-8 w-28"
                    value={d.end}
                    disabled={!d.enabled}
                    onChange={(e) => patchDay(d.day, { end: e.target.value })}
                  />
                </div>
              </div>
            ))}
          </div>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button onClick={handleSave} disabled={saving || loading || Boolean(loadError)}>
            {saving ? "Saving..." : "Save hours"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
