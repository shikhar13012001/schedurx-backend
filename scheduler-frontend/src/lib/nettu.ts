// Server-side client for the nettu-scheduler REST API.
// Only import from route handlers — the API key must never reach the browser.
//
// API conventions (verified against source):
//   Auth:        x-api-key header (account/admin routes)
//   Timestamps:  epoch milliseconds
//   Duration:    milliseconds
//   Events list: GET /api/v1/user/calendar/{calendarId}/events?startTs=&endTs=
//   Schedule:    GET/PUT /api/v1/user/schedule/{scheduleId}
//
// FOLLOW-UP: this duplicates ../../../src/services/nettu-client.js (moved here from
// schedurx-ultravox-demo-api alongside this app). They were independent before the split
// and still are — consolidating them (e.g. having this app call the Express /tools API,
// or sharing a single client) is out of scope for the migration that relocated this file.

export class NettuError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = "NettuError";
    this.status = status;
  }
}

function env(name: string): string {
  const val = process.env[name];
  if (!val) throw new Error(`Missing environment variable: ${name}`);
  return val;
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${env("NETTU_BASE_URL")}${path}`, {
    method,
    headers: {
      "x-api-key": env("NETTU_API_KEY"),
      "Content-Type": "application/json",
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
    cache: "no-store",
    signal: AbortSignal.timeout(10_000),
  });

  let json: Record<string, unknown> | null = null;
  try {
    json = await res.json();
  } catch {
    /* empty body */
  }

  if (!res.ok) {
    const msg =
      (json?.message as string) ?? (json?.error as string) ?? `HTTP ${res.status}`;
    throw new NettuError(`Nettu API error: ${msg}`, res.status);
  }

  return json as T;
}

// ─── Events ───────────────────────────────────────────────────────────────────

export interface NettuEvent {
  id: string;
  startTs: number;
  duration: number;
  busy?: boolean;
  calendarId?: string;
  userId?: string;
  metadata?: Record<string, unknown>;
}

export async function getCalendarEvents(
  calendarId: string,
  startTs: number,
  endTs: number,
): Promise<NettuEvent[]> {
  const data = await request<{ events?: Array<{ event: NettuEvent }> }>(
    "GET",
    `/api/v1/user/calendar/${calendarId}/events?startTs=${startTs}&endTs=${endTs}`,
  );
  return (data.events ?? []).map((e) => e.event);
}

export async function createEvent(
  userId: string,
  opts: {
    calendarId: string;
    startTs: number;
    durationMs: number;
    busy?: boolean;
    metadata?: Record<string, unknown>;
  },
): Promise<NettuEvent> {
  const data = await request<{ event: NettuEvent }>("POST", `/api/v1/user/${userId}/events`, {
    calendarId: opts.calendarId,
    startTs: opts.startTs,
    duration: opts.durationMs,
    busy: opts.busy ?? true,
    metadata: opts.metadata ?? {},
  });
  return data.event;
}

// Admin event mutation routes take only the event ID: /user/events/{eventId}.
export async function updateEvent(
  eventId: string,
  opts: { startTs?: number; durationMs?: number; busy?: boolean; metadata?: Record<string, unknown> },
): Promise<NettuEvent> {
  const body: Record<string, unknown> = {};
  if (opts.startTs !== undefined) body.startTs = opts.startTs;
  if (opts.durationMs !== undefined) body.duration = opts.durationMs;
  if (opts.busy !== undefined) body.busy = opts.busy;
  if (opts.metadata !== undefined) body.metadata = opts.metadata;
  const data = await request<{ event: NettuEvent }>(
    "PUT",
    `/api/v1/user/events/${eventId}`,
    body,
  );
  return data.event;
}

export async function deleteEvent(eventId: string): Promise<void> {
  await request("DELETE", `/api/v1/user/events/${eventId}`);
}

// ─── Services (used to resolve a doctor's schedule ID) ────────────────────────

interface ServiceUser {
  userId: string;
  availability?: { variant: string; id: string };
}

export async function getService(serviceId: string): Promise<{ users: ServiceUser[] } | null> {
  try {
    // GET /service/{id} returns the service object directly (no { service } wrapper).
    const data = await request<{ users?: ServiceUser[]; service?: { users?: ServiceUser[] } }>(
      "GET",
      `/api/v1/service/${serviceId}`,
    );
    const service = data.service ?? data;
    return { users: service.users ?? [] };
  } catch (err) {
    if (err instanceof NettuError && err.status === 404) return null;
    throw err;
  }
}

// ─── Schedules (working hours) ────────────────────────────────────────────────

export interface NettuScheduleRule {
  variant: { type: string; value: string };
  intervals: Array<{
    start: { hours: number; minutes: number };
    end: { hours: number; minutes: number };
  }>;
}

export interface NettuSchedule {
  id: string;
  timezone: string;
  rules: NettuScheduleRule[];
}

export async function getSchedule(scheduleId: string): Promise<NettuSchedule> {
  const data = await request<{ schedule: NettuSchedule }>(
    "GET",
    `/api/v1/user/schedule/${scheduleId}`,
  );
  return data.schedule;
}

export async function updateSchedule(
  scheduleId: string,
  opts: { timezone?: string; rules?: NettuScheduleRule[] },
): Promise<NettuSchedule> {
  const data = await request<{ schedule: NettuSchedule }>(
    "PUT",
    `/api/v1/user/schedule/${scheduleId}`,
    opts,
  );
  return data.schedule;
}
