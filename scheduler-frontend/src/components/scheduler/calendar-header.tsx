"use client";

import { addDays, addMonths, addWeeks, endOfWeek, format, isSameMonth, startOfWeek } from "date-fns";
import { CalendarDays, ChevronLeft, ChevronRight, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import type { ViewMode } from "@/hooks/use-scheduler";

interface CalendarHeaderProps {
  view: ViewMode;
  anchor: Date;
  loading: boolean;
  onViewChange: (view: ViewMode) => void;
  onAnchorChange: (date: Date) => void;
  onRefresh: () => void;
}

function rangeLabel(view: ViewMode, anchor: Date): string {
  if (view === "day") return format(anchor, "EEEE, d MMMM yyyy");
  if (view === "month") return format(anchor, "MMMM yyyy");
  const start = startOfWeek(anchor, { weekStartsOn: 1 });
  const end = endOfWeek(anchor, { weekStartsOn: 1 });
  if (isSameMonth(start, end)) return `${format(start, "d")} - ${format(end, "d MMM yyyy")}`;
  return `${format(start, "d MMM")} - ${format(end, "d MMM yyyy")}`;
}

export function CalendarHeader({
  view,
  anchor,
  loading,
  onViewChange,
  onAnchorChange,
  onRefresh,
}: CalendarHeaderProps) {
  const step = (dir: 1 | -1) => {
    if (view === "day") onAnchorChange(addDays(anchor, dir));
    else if (view === "week") onAnchorChange(addWeeks(anchor, dir));
    else onAnchorChange(addMonths(anchor, dir));
  };

  return (
    <div className="flex flex-col gap-3 border-b bg-card px-3 py-3 sm:px-4 lg:flex-row lg:items-center lg:justify-between">
      <div className="flex min-w-0 items-center gap-3">
        <div className="flex size-9 shrink-0 items-center justify-center rounded-md bg-primary/10 text-primary">
          <CalendarDays className="size-4" aria-hidden="true" />
        </div>
        <div className="min-w-0">
          <p className="text-[11px] font-semibold uppercase leading-none text-muted-foreground">
            Calendar
          </p>
          <h2 className="mt-1 truncate text-xl font-semibold leading-none tracking-normal sm:text-2xl">
            {rangeLabel(view, anchor)}
          </h2>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <Button variant="outline" size="sm" className="font-semibold" onClick={() => onAnchorChange(new Date())}>
          Today
        </Button>
        <div className="flex items-center rounded-lg border bg-background p-0.5">
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={() => step(-1)}
            aria-label="Previous range"
          >
            <ChevronLeft className="h-4 w-4" />
          </Button>
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={() => step(1)}
            aria-label="Next range"
          >
            <ChevronRight className="h-4 w-4" />
          </Button>
        </div>
        <Button
          variant="ghost"
          size="icon-sm"
          className="border"
          onClick={onRefresh}
          disabled={loading}
          aria-label="Refresh calendar"
        >
          <RefreshCw className={loading ? "h-4 w-4 animate-spin" : "h-4 w-4"} />
        </Button>
        <Tabs value={view} onValueChange={(v) => onViewChange(v as ViewMode)}>
          <TabsList className="bg-background">
            <TabsTrigger value="day">Day</TabsTrigger>
            <TabsTrigger value="week">Week</TabsTrigger>
            <TabsTrigger value="month">Month</TabsTrigger>
          </TabsList>
        </Tabs>
      </div>
    </div>
  );
}
