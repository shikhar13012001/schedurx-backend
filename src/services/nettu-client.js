// HTTP client for the nettu-scheduler REST API.
//
// API conventions (verified against source):
//   Auth:          x-api-key header
//   Base path:     /api/v1/...
//   Body fields:   camelCase  (serde rename_all = "camelCase")
//   Timestamps:    epoch milliseconds (i64)
//   Duration:      milliseconds (i64)
//   Query params:  camelCase for service endpoints
//
// ScheduleRuleVariant tagged enum:  { type: "WDay", value: "Mon" }  (one rule per weekday)
// TimePlan tagged enum:             { variant: "Schedule", id: "..." }
// BusyCalendar tagged enum:         { provider: "Nettu", id: "..." }

class NettuApiError extends Error {
  constructor(message, httpStatus) {
    super(message);
    this.name = "NettuApiError";
    this.httpStatus = httpStatus;
  }
}

class NettuClient {
  #baseUrl;
  #apiKey;
  #logger;
  #timeoutMs;
  #fetchImpl;

  constructor({ baseUrl, apiKey, logger, fetchImpl = globalThis.fetch, timeoutMs = 10_000 }) {
    if (!baseUrl) throw new Error("NettuClient: baseUrl is required");
    if (!apiKey) throw new Error("NettuClient: apiKey is required");

    this.#baseUrl = baseUrl.replace(/\/$/, "");
    this.#apiKey = apiKey;
    this.#logger = logger;
    this.#timeoutMs = timeoutMs;
    this.#fetchImpl = fetchImpl;
  }

  // ─── Internal ─────────────────────────────────────────────────────────────

  async #request(method, path, body) {
    const url = `${this.#baseUrl}${path}`;
    const headers = { "x-api-key": this.#apiKey, "Content-Type": "application/json" };
    const init = { method, headers, signal: AbortSignal.timeout(this.#timeoutMs) };
    if (body !== undefined) init.body = JSON.stringify(body);

    this.#logger?.debug({ method, path }, "[nettu] request");

    let response;
    try {
      response = await this.#fetchImpl(url, init);
    } catch (cause) {
      const msg =
        cause?.name === "AbortError"
          ? `Nettu API timed out after ${this.#timeoutMs}ms`
          : `Nettu API network error: ${cause.message}`;
      throw new NettuApiError(msg, 0);
    }

    let json = null;
    const ct = response.headers.get("content-type") ?? "";
    if (ct.includes("application/json")) {
      try {
        json = await response.json();
      } catch {
        /* empty body */
      }
    }

    if (!response.ok) {
      const msg = json?.message ?? json?.error ?? `HTTP ${response.status}`;
      this.#logger?.warn({ method, path, status: response.status, responseBody: json }, "[nettu] non-2xx response");
      throw new NettuApiError(`Nettu API error: ${msg}`, response.status);
    }

    return json;
  }

  // ─── Users ────────────────────────────────────────────────────────────────

  async createUser(metadata = {}) {
    const data = await this.#request("POST", "/api/v1/user", { metadata });
    return data.user;
  }

  async getUser(userId) {
    try {
      const data = await this.#request("GET", `/api/v1/user/${userId}`);
      return data.user ?? data;
    } catch (err) {
      if (err instanceof NettuApiError && err.httpStatus === 404) return null;
      throw err;
    }
  }

  // ─── Calendars ────────────────────────────────────────────────────────────

  async createCalendar(userId, { timezone, metadata = {} }) {
    const data = await this.#request("POST", `/api/v1/user/${userId}/calendar`, { timezone, metadata });
    return data.calendar;
  }

  async getCalendar(userId, calendarId) {
    try {
      const data = await this.#request("GET", `/api/v1/user/${userId}/calendar/${calendarId}`);
      return data.calendar ?? data;
    } catch (err) {
      if (err instanceof NettuApiError && err.httpStatus === 404) return null;
      throw err;
    }
  }

  // ─── Schedules (working hours) ────────────────────────────────────────────
  //
  // Rules: one object per weekday, variant is a tagged enum:
  //   { variant: { type: "WDay", value: "Mon" }, intervals: [{ start: {hours,minutes}, end: {hours,minutes} }] }
  //
  // Creation:  POST /api/v1/user/{userId}/schedule
  // Get:       GET  /api/v1/user/schedule/{scheduleId}
  // Update:    PUT  /api/v1/user/schedule/{scheduleId}
  //
  // NOTE: nettu has no "list schedules for user" endpoint. To find a doctor's
  // existing schedule, resolve it via the clinic service:
  // service.users[].availability.id (see calendar-service.findExistingSchedule).

  async createSchedule(userId, { timezone, rules = [] }) {
    const data = await this.#request("POST", `/api/v1/user/${userId}/schedule`, { timezone, rules });
    return data.schedule;
  }

  async getSchedule(scheduleId) {
    try {
      const data = await this.#request("GET", `/api/v1/user/schedule/${scheduleId}`);
      return data.schedule ?? data;
    } catch (err) {
      if (err instanceof NettuApiError && err.httpStatus === 404) return null;
      throw err;
    }
  }

  async updateSchedule(scheduleId, { timezone, rules }) {
    const body = {};
    if (timezone !== undefined) body.timezone = timezone;
    if (rules !== undefined) body.rules = rules;
    const data = await this.#request("PUT", `/api/v1/user/schedule/${scheduleId}`, body);
    return data.schedule;
  }

  // ─── Account ──────────────────────────────────────────────────────────────
  //
  // One-time admin setup, not called on the request path — see
  // scripts/setup-nettu-webhook.js. Registers where nettu POSTs reminders;
  // the returned `key` must be verified on every incoming webhook call
  // (nettu echoes it back in the `nettu-scheduler-webhook-key` header).

  async setAccountWebhook(webhookUrl) {
    const data = await this.#request("PUT", "/api/v1/account/webhook", { webhookUrl });
    return data.account;
  }

  // ─── Services ─────────────────────────────────────────────────────────────

  async createService(metadata = {}) {
    const data = await this.#request("POST", "/api/v1/service", { metadata });
    return data.service;
  }

  async getService(serviceId) {
    try {
      // GET /service/{id} returns the service object directly (no { service } wrapper).
      const data = await this.#request("GET", `/api/v1/service/${serviceId}`);
      return data.service ?? data;
    } catch (err) {
      if (err instanceof NettuApiError && err.httpStatus === 404) return null;
      throw err;
    }
  }

  async updateService(serviceId, updates) {
    const data = await this.#request("PUT", `/api/v1/service/${serviceId}`, updates);
    return data.service;
  }

  // Add a doctor (nettu User) to a clinic Service.
  // availability uses the TimePlan tagged enum: { variant: "Schedule", id: scheduleId }
  // bufferAfter: minutes of buffer after each appointment (from buffer_after, camelCase)
  async addUserToService(serviceId, { userId, scheduleId, bufferAfter = 0 }) {
    const body = {
      userId,
      availability: { variant: "Schedule", id: scheduleId },
      bufferAfter,
    };
    const data = await this.#request("POST", `/api/v1/service/${serviceId}/users`, body);
    return data.service ?? data;
  }

  // Register a calendar as a "busy" source for a service user.
  // PUT /api/v1/service/{serviceId}/users/{userId}/busy
  // BusyCalendar enum: { provider: "Nettu", id: calendarId }
  async addBusyCalendar(serviceId, userId, calendarId) {
    const body = { busy: { provider: "Nettu", id: calendarId } };
    return this.#request("PUT", `/api/v1/service/${serviceId}/users/${userId}/busy`, body);
  }

  // ─── Booking slots ────────────────────────────────────────────────────────
  //
  // Returns a flat array of { start: epochMs, duration: ms } objects.
  // startDate / endDate: "YYYY-MM-DD" strings (interpreted in timezone).
  // duration / interval: milliseconds.
  // hostUserIds: comma-separated string of user IDs, or a single ID.
  //
  // Response shape: { dates: [{ date: "YYYY-MM-DD", slots: [{ start, duration, userIds }] }] }

  async getBookingSlots(serviceId, { hostUserId, startDate, endDate, durationMs, intervalMs, timezone }) {
    const params = new URLSearchParams({
      startDate,
      endDate,
      duration: String(durationMs),
      interval: String(intervalMs ?? durationMs),
      timezone,
    });
    if (hostUserId) params.set("hostUserIds", hostUserId);

    const data = await this.#request("GET", `/api/v1/service/${serviceId}/booking?${params}`);

    // Flatten the dates → slots structure into a simple array.
    const slots = [];
    for (const dateEntry of data.dates ?? []) {
      for (const slot of dateEntry.slots ?? []) {
        slots.push({ start: slot.start, duration: slot.duration });
      }
    }
    return slots;
  }

  // ─── Calendar Events ──────────────────────────────────────────────────────
  //
  // Used to create the actual booking record in the doctor's calendar.
  // startTs:  epoch milliseconds  (field name is startTs, not startTime)
  // duration: milliseconds
  // serviceId links the event to the service (enables conflict detection in nettu)

  // reminders: [{ delta: minutes (negative = before start), identifier: string }]
  // — nettu POSTs to the account's configured webhook (see setAccountWebhook)
  // `delta` minutes before the event starts, with this event + identifier.
  async createEvent(userId, { calendarId, startTs, durationMs, busy = true, serviceId, metadata = {}, reminders }) {
    const data = await this.#request("POST", `/api/v1/user/${userId}/events`, {
      calendarId,
      startTs,
      duration: durationMs,
      busy,
      serviceId: serviceId ?? undefined,
      metadata,
      reminders: reminders ?? undefined,
    });
    return data.event;
  }

  // Admin event get/update/delete routes take only the event ID:
  // /api/v1/user/events/{eventId} — no user ID in the path.
  // The userId parameter is kept for signature stability but not used.

  async updateEvent(userId, eventId, { startTs, durationMs, busy, metadata, reminders }) {
    const body = {};
    if (startTs !== undefined) body.startTs = startTs;
    if (durationMs !== undefined) body.duration = durationMs;
    if (busy !== undefined) body.busy = busy;
    if (metadata !== undefined) body.metadata = metadata;
    if (reminders !== undefined) body.reminders = reminders;
    const data = await this.#request("PUT", `/api/v1/user/events/${eventId}`, body);
    return data.event;
  }

  async deleteEvent(userId, eventId) {
    const data = await this.#request("DELETE", `/api/v1/user/events/${eventId}`);
    return data?.event ?? null;
  }

  async getEvent(userId, eventId) {
    try {
      const data = await this.#request("GET", `/api/v1/user/events/${eventId}`);
      return data.event ?? data;
    } catch (err) {
      if (err instanceof NettuApiError && err.httpStatus === 404) return null;
      throw err;
    }
  }
}

module.exports = { NettuClient, NettuApiError };
