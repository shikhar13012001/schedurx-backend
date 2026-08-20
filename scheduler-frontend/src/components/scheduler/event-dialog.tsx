"use client";

// Create / edit / delete a calendar event.

import { useEffect, useState } from "react";
import { format } from "date-fns";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import type { CalEvent } from "@/lib/types";
import type { DoctorWithColor } from "@/hooks/use-scheduler";

const DURATIONS = [15, 30, 45, 60, 90, 120];

const selectClass =
  "h-9 w-full rounded-lg border border-input bg-transparent px-2.5 text-sm outline-none transition-colors focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50 dark:bg-input/30";

export type EventDialogState =
  | { mode: "create"; start: Date; doctorId?: string }
  | { mode: "edit"; event: CalEvent }
  | null;

interface EventDialogProps {
  state: EventDialogState;
  doctors: DoctorWithColor[];
  onClose: () => void;
  onCreate: (opts: {
    doctorId: string;
    startTs: number;
    durationMs: number;
    title: string;
    busy: boolean;
  }) => Promise<void>;
  onUpdate: (
    eventId: string,
    opts: { doctorId: string; startTs: number; durationMs: number; title: string; busy: boolean },
  ) => Promise<void>;
  onDelete: (eventId: string, doctorId: string) => Promise<void>;
}

export function EventDialog({
  state,
  doctors,
  onClose,
  onCreate,
  onUpdate,
  onDelete,
}: EventDialogProps) {
  const [doctorId, setDoctorId] = useState("");
  const [title, setTitle] = useState("");
  const [date, setDate] = useState("");
  const [time, setTime] = useState("");
  const [duration, setDuration] = useState("30");
  const [busy, setBusy] = useState(true);
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);

  // Sync form whenever the dialog opens.
  useEffect(() => {
    if (!state) return;
    let cancelled = false;
    void Promise.resolve().then(() => {
      if (cancelled) return;
      if (state.mode === "create") {
        const firstBookable = doctors.find((d) => d.hasCalendar);
        setDoctorId(state.doctorId ?? firstBookable?.id ?? "");
        setTitle("Appointment");
        setDate(format(state.start, "yyyy-MM-dd"));
        setTime(format(state.start, "HH:mm"));
        setDuration("30");
        setBusy(true);
      } else {
        const e = state.event;
        setDoctorId(e.doctorId);
        setTitle(e.title);
        setDate(format(new Date(e.startTs), "yyyy-MM-dd"));
        setTime(format(new Date(e.startTs), "HH:mm"));
        setDuration(String(Math.round((e.endTs - e.startTs) / 60_000)));
        setBusy(e.busy);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [state, doctors]);

  if (!state) return null;

  const isEdit = state.mode === "edit";
  const selectedDoctor = doctors.find((d) => d.id === doctorId);

  const buildPayload = () => {
    const start = new Date(`${date}T${time}:00`);
    if (isNaN(start.getTime())) {
      toast.error("Invalid date or time");
      return null;
    }
    if (!doctorId) {
      toast.error("Select a doctor");
      return null;
    }
    return {
      doctorId,
      startTs: start.getTime(),
      durationMs: Number(duration) * 60_000,
      title: title.trim() || "Appointment",
      busy,
    };
  };

  const handleSave = async () => {
    const payload = buildPayload();
    if (!payload) return;
    setSaving(true);
    try {
      if (isEdit) {
        await onUpdate(state.event.id, payload);
        toast.success("Event updated");
      } else {
        await onCreate(payload);
        toast.success("Event created");
      }
      onClose();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to save event");
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async () => {
    if (!isEdit) return;
    setDeleting(true);
    try {
      await onDelete(state.event.id, state.event.doctorId);
      toast.success("Event deleted");
      onClose();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to delete event");
    } finally {
      setDeleting(false);
    }
  };

  const durationOptions = DURATIONS.includes(Number(duration))
    ? DURATIONS
    : [...DURATIONS, Number(duration) || 30].sort((a, b) => a - b);

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            {selectedDoctor && (
              <span
                className="h-3 w-3 rounded-full"
                style={{ backgroundColor: selectedDoctor.color }}
              />
            )}
            {isEdit ? "Edit appointment" : "New appointment"}
          </DialogTitle>
        </DialogHeader>

        <div className="grid gap-4 py-2">
          <div className="grid gap-2">
            <Label htmlFor="evt-doctor">Doctor</Label>
            <select
              id="evt-doctor"
              className={selectClass}
              value={doctorId}
              onChange={(e) => setDoctorId(e.target.value)}
              disabled={isEdit}
            >
              <option value="" disabled>
                Select a doctor
              </option>
              {doctors.map((d) => (
                <option key={d.id} value={d.id} disabled={!d.hasCalendar}>
                  {d.fullName}
                  {d.specialty ? ` - ${d.specialty}` : ""}
                  {!d.hasCalendar ? " (no calendar)" : ""}
                </option>
              ))}
            </select>
          </div>

          <div className="grid gap-2">
            <Label htmlFor="evt-title">Title</Label>
            <Input
              id="evt-title"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="Appointment"
            />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="grid gap-2">
              <Label htmlFor="evt-date">Date</Label>
              <Input
                id="evt-date"
                type="date"
                value={date}
                onChange={(e) => setDate(e.target.value)}
              />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="evt-time">Start time</Label>
              <Input
                id="evt-time"
                type="time"
                step={900}
                value={time}
                onChange={(e) => setTime(e.target.value)}
              />
            </div>
          </div>

          <div className="grid grid-cols-2 items-end gap-3">
            <div className="grid gap-2">
              <Label htmlFor="evt-duration">Duration</Label>
              <select
                id="evt-duration"
                className={selectClass}
                value={duration}
                onChange={(e) => setDuration(e.target.value)}
              >
                {durationOptions.map((m) => (
                  <option key={m} value={String(m)}>
                    {m} minutes
                  </option>
                ))}
              </select>
            </div>
            <div className="flex h-9 items-center justify-between rounded-lg border bg-muted/30 px-3">
              <Label htmlFor="evt-busy" className="text-sm">
                Blocks slot
              </Label>
              <Switch id="evt-busy" checked={busy} onCheckedChange={(c) => setBusy(c)} />
            </div>
          </div>
        </div>

        <DialogFooter className="gap-2 sm:justify-between">
          {isEdit ? (
            <Button variant="destructive" onClick={handleDelete} disabled={deleting || saving}>
              {deleting ? "Deleting..." : "Delete"}
            </Button>
          ) : (
            <span />
          )}
          <div className="flex gap-2">
            <Button variant="outline" onClick={onClose} disabled={saving || deleting}>
              Cancel
            </Button>
            <Button onClick={handleSave} disabled={saving || deleting}>
              {saving ? "Saving..." : isEdit ? "Save changes" : "Create"}
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
