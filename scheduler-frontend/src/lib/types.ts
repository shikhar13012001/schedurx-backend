// Shared types between API route handlers and UI components.

export interface Doctor {
  id: string;
  fullName: string;
  specialty: string | null;
  feeInr: number;
  timezone: string;
  hasCalendar: boolean;
}

export interface CalEvent {
  id: string;
  doctorId: string;
  title: string;
  startTs: number; // epoch ms
  endTs: number;   // epoch ms
  busy: boolean;
}

export type Weekday = "Mon" | "Tue" | "Wed" | "Thu" | "Fri" | "Sat" | "Sun";

export const WEEKDAYS: Weekday[] = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

// One row in the working-hours editor: "HH:mm" strings.
export interface DaySchedule {
  day: Weekday;
  enabled: boolean;
  start: string;
  end: string;
}

export interface DoctorSchedule {
  scheduleId: string;
  timezone: string;
  days: DaySchedule[];
}
