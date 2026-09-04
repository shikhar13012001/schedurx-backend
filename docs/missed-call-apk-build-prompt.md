# ScheduRx Missed-Call Safety Net — Android APK Build Prompt

Prepared for Shikhar / ScheduRx. Target: a Claude Code session with `schedurx-backend` and `schedurx-platform-v3-mvp-design` attached, producing a sideloadable Android APK.

---

## 1. Business objective

ScheduRx already has one missed-call recovery path: a clinic sets up carrier call-forwarding (dial-code activated) so an unanswered call on the clinic's real number forwards to a shared Twilio number, which the IVR answers, and on no-answer fires a WhatsApp/SMS "sorry we missed your call, book here" message. That path depends entirely on the clinic correctly configuring carrier forwarding, and only ever sees calls that got forwarded.

This project adds a second, more direct path: an Android app installed on the actual phone a staff member (receptionist or doctor) takes patient calls on. It watches that phone's native call log in real time. When a call goes unanswered:

- If the caller is already in the phone's contacts, and not on a manually maintained "log anyway" whitelist, nothing happens — a known/expected caller doesn't need a recovery message.
- If the caller is unknown (or is a known contact someone has explicitly whitelisted), the app reports the missed call to the ScheduRx backend, which auto-creates a Patient/lead record and fires the same `missed_call_followup` WhatsApp automation that already exists — no new message logic, no separate template system.

Net effect: a safety net that works even when carrier forwarding isn't set up, isn't set up correctly, or the clinic simply prefers to keep answering calls on the real phone. Outbound *calling* back the patient is explicitly out of scope for this build — WhatsApp is the only recovery channel for now, matching what's already live.

Distribution is sideload-only (a downloadable APK, installed manually on clinic devices) — Google Play does not allow `READ_CALL_LOG` for an app that isn't the phone's default dialer, and turning ScheduRx into a dialer replacement is a different, much bigger project. This one is scoped as an internal companion tool, not a Play Store product.

## 2. What already exists — read this before building anything

This is not a greenfield build. Large parts of the backend for this feature already exist and must be reused, not reinvented:

- **`missed_call_followup` is already a first-class workflow trigger.** `src/services/clinic-service.js` ships a default workflow (`id: "missed-call-wa"`) with a real Meta-approved WhatsApp Content Template (`HXf5ef9c0012d304928116c210bc23a2d7`) plus an SMS fallback, gated by `Clinic.settings.communication.workflows`. It's also already selectable in the dashboard's Automations page (`src/app/(app)/automations/page.tsx`, `TRIGGERS` array).
- **The send logic already exists**, in `triggerMissedCallFollowup()` at the bottom of `src/routes/webhooks-twilio.js`. It looks up the enabled `missed_call_followup` workflow, builds a pre-booking `bookingUrl`, and calls `messagingSvc.sendTemplatedMessage(...)`. Today it only fires from the Twilio voice-webhook path (an unanswered forwarded call). This function needs to be **extracted into a shared service** (recommend moving it into `src/services/comms-workflow-service.js`, renamed something like `sendMissedCallFollowup`) so both the Twilio path and the new Android path call the exact same code — do not duplicate this logic.
- **`CallLog` table already exists** (`supabase/migrations/20260808_call_logs.sql`) with an `outcome` check constraint that already includes `'recovered_missed'`. It currently assumes a Twilio-originated call (`twilioCallSid` optional column added later). Extend it rather than creating a parallel table — add `source` (`'twilio_ivr'` default, vs `'android_native'`), `staffId`, and `deviceCallTimestamp` (bigint epoch ms, for idempotency — Android's own `CallLog.Calls.DATE`). This means missed calls detected by the APK show up in the existing dashboard History tab for free, no frontend work needed there.
- **Patient auto-creation on unknown inbound contact already exists** — `tableSvc.findOrCreatePatient(supabaseClient, clinicId, { phone })`, used by the WhatsApp-inbound webhook in `webhooks-twilio.js`. Reuse it verbatim for the auto-create-lead behavior.
- **Auth is already staff-scoped.** `/api/v1/*` runs behind `firebaseAuth` middleware, which resolves a verified Firebase ID token to `req.staff = { staffId, role, clinicId, doctorId, ... }`. The Android app authenticates exactly like the web dashboard does (same Firebase project, same login), so a new endpoint under `/api/v1` gets clinic/staff scoping for free — do not invent a separate auth scheme.
- **Phone normalization** — always run numbers through `normalizeIndianMobile()` in `src/lib/phone.js` at every boundary (device app included) before they hit the DB or Twilio.
- **The frontend is already a mobile-first PWA** — `public/manifest.webmanifest`, `public/sw.js`, `public/icons/icon-{192,512}.png` already exist. The visual system is fully documented in `DESIGN_SOURCE.md` and `src/app/globals.css` (CSS custom properties: warm off-white `--bg`, stone/taupe surfaces, one vivid orange `--primary`, charcoal `--ink`). This is why the recommended approach (below) is to literally wrap the live app rather than rebuild any UI.

Read all of the above files in full before writing code. The point of this section is: most of the hard product-logic decisions are already made and already shipped for the Twilio path — this build is about a new *input* into that same pipe, not a new pipe.

## 3. Decisions already made (don't re-litigate these)

- **Distribution:** sideload only. No Play Store submission, no default-dialer role.
- **Shell technology:** Capacitor, wrapping the *live* deployed dashboard (`server.url` pointed at the deployed origin, e.g. `https://app.schedurx.com`), not a native UI rebuild and not a bundled static export. Zero design work — the APK shows literally the same Next.js app already in production. This also means every future web-side design change ships to the APK automatically, with no rebuild.
- **Auth / device model:** per-staff Firebase login, same as the web dashboard. Whoever's phone is actually taking patient calls (receptionist or a doctor with a direct line) logs into their own account inside the app.
- **Missed-call handling:** auto-create a Patient/lead record for unknown callers (via `findOrCreatePatient`), then fire the existing `missed_call_followup` workflow. Don't just log-and-forget.

## 4. Technical architecture to build

### 4.0 Phase 0 — de-risk first (do this before anything else)

The single biggest unknown is whether a Capacitor app configured with a **remote `server.url`** (rather than a bundled local `webDir`) reliably exposes `window.Capacitor` and a custom native plugin to that remote page. This is a documented, supported Capacitor pattern (used for exactly this "wrap an existing live site" case), but verify it concretely first: scaffold a minimal Capacitor project, point it at the deployed dashboard URL, add one trivial custom plugin (e.g. return a hardcoded string), confirm it's callable from the live page's browser console/dev bundle. If this doesn't hold up cleanly, fall back to a bundled local `webDir` that does a client-side redirect/iframe to the live origin for everything except the one settings screen that needs the native bridge — but try the direct remote-URL approach first, it's much simpler.

### 4.1 Android shell (Capacitor)

- New Capacitor project, suggested location: `schedurx-platform-v3-mvp-design/mobile-shell/` (own `package.json`, `capacitor.config.ts`, generated `android/` native project) — keeps it inside the already-existing frontend repo rather than a new top-level folder.
- `capacitor.config.ts`: `appId` (suggest `com.schedurx.app`), `appName: "ScheduRx"`, `server.url` = the deployed dashboard origin, `server.androidScheme: "https"`.
- App icon / splash generated from the existing `public/icons/icon-512.png` (use `@capacitor/assets` or manual `mipmap` generation) — reuse the real product icon, don't design a new one.
- Standard Capacitor plugins needed: `@capacitor/app` (lifecycle), `@capacitor/preferences` (local key-value store for dedupe/cache), `@capacitor/push-notifications` only if you want native push later — not required for v1 since the web app already has its own push flow via VAPID/service worker (verify that still works inside a WebView shell; if not, note it as a known gap, don't silently drop it).

### 4.2 Custom native plugin — call detection (Kotlin)

Build a Capacitor plugin (Kotlin) named something like `MissedCallPlugin`, exposing methods the web app can call: `requestPermissions()`, `checkPermissions()`, `getWhitelist()/setWhitelist()` (if you decide to cache it locally — see 4.4), and events it emits to JS: `missedCallDetected`.

**Detection mechanism — use a manifest-registered `BroadcastReceiver` on `android.intent.action.PHONE_STATE`, not a persistent foreground service.** A foreground service means a permanent notification and more OEM battery-management friction for no real benefit here; a `PHONE_STATE` receiver is the standard lightweight pattern and still fires even when the app isn't in the foreground, because it's a permission-protected system broadcast (not affected by the Android 8+ implicit-broadcast restrictions, which target things like `CONNECTIVITY_ACTION`).

Logic:
1. Track state transitions: `RINGING` → (`OFFHOOK` = answered, ignore) or `RINGING` → `IDLE` directly = missed/rejected call.
2. On detecting a `RINGING → IDLE` transition, query `CallLog.Calls.CONTENT_URI` (sorted by `DATE DESC`, limit 1) rather than trusting the broadcast's `EXTRA_INCOMING_NUMBER` (unreliable/gated across Android versions) — read the number, timestamp, and `TYPE` off that row directly. Only proceed if `TYPE == CallLog.Calls.MISSED_TYPE`.
3. Look up the number against `ContactsContract` — if it resolves to a saved contact name, it's "known." Check the local whitelist cache (4.4) — if the number is on it, treat as "log anyway" regardless of known/unknown.
4. Dedupe locally against the last-processed call timestamp (Preferences) before doing any network call — the same call can otherwise get processed twice (receiver re-registration, OEM quirks).
5. If it should be logged: enqueue a `WorkManager` one-time work request (survives app-kill, retries with backoff, works offline-then-flushes) that POSTs to the backend endpoint in 4.3, carrying the staff's cached Firebase ID token (refresh if expired before sending).

Permissions required in `AndroidManifest.xml`: `READ_CALL_LOG`, `READ_CONTACTS`, `READ_PHONE_STATE`, `POST_NOTIFICATIONS` (Android 13+, needed if you show any status notification), `INTERNET`, `ACCESS_NETWORK_STATE`. All of `READ_CALL_LOG`/`READ_CONTACTS`/`READ_PHONE_STATE` are dangerous permissions — build a proper runtime request flow with a rationale screen that matches the app's own design language (warm off-white, the same copy tone as the rest of onboarding) explaining *why* the app needs call-log access, before firing the system permission dialog. Handle "permanently denied" (user checked "don't ask again") with a deep link to the app's system settings page.

**Explicitly verify current Android/Play policy before finalizing permission handling and any foreground-service type** — Android's background-execution and permission rules have continued to tighten release over release, and given how much time may have passed since this document was written, don't assume the specifics above are still exactly current; check the latest Android developer docs for `READ_CALL_LOG` runtime behavior and any foreground-service-type requirements before shipping.

**India-specific reliability note:** Xiaomi (MIUI), Vivo, Oppo, and OnePlus are aggressive about killing background receivers/services to save battery, and are extremely common devices in the Bengaluru clinic market this targets. Add an explicit "please allow ScheduRx to run in the background" screen that requests exemption from battery optimization (`REQUEST_IGNORE_BATTERY_OPTIMIZATIONS`) and, where feasible, links to the OEM-specific autostart/battery settings screen (there's no single API for this across OEMs — a simple "manufacturer detected: here's where to look" help card is the pragmatic approach). Flag this to Shikhar as the single biggest real-world reliability risk for this feature, bigger than any of the code above.

### 4.3 Backend changes

New migration (follow the existing `YYYYMMDD_description.sql` naming convention in `supabase/migrations/`, using `CREATE ... IF NOT EXISTS` / `ADD COLUMN IF NOT EXISTS` like every other migration in this repo):

- Extend `CallLog`: add `source text NOT NULL DEFAULT 'twilio_ivr'` with a check constraint allowing `('twilio_ivr','android_native')`, `staffId text REFERENCES "Staff"(id)`, `deviceCallTimestamp bigint`. Add a unique index on `(clinicId, phone, "deviceCallTimestamp")` where `"deviceCallTimestamp" IS NOT NULL`, for idempotency against WorkManager retries / receiver double-fires.
- New table `CallerWhitelist`: `id, clinicId, phone (normalized), label, addedByStaffId, createdAt`, unique on `(clinicId, phone)`. This is clinic-scoped, not per-staff — it's a clinic policy ("always log calls from this known number") not a personal preference, so any staff member's app should honor the same list.

New service: extract `triggerMissedCallFollowup` out of `webhooks-twilio.js` into `src/services/comms-workflow-service.js` (or a new small `src/services/missed-call-service.js` if you'd rather keep it separate from the appointment-lifecycle logic already in comms-workflow-service.js — your call, just don't duplicate it in two places). Add a wrapper, e.g. `handleDeviceMissedCall(supabaseClient, twilioClient, { clinicId, staffId, doctorId, phone, deviceCallTimestamp }, log)` that: normalizes the phone, checks the idempotency unique index (swallow the conflict, don't error), calls `findOrCreatePatient`, writes the `CallLog` row (`source: 'android_native'`, `outcome: 'recovered_missed'` once the send succeeds, `'info'` if it doesn't — mirror how `createCallLog` already handles optional fields), then calls the shared `sendMissedCallFollowup`/`triggerMissedCallFollowup` function.

New routes:
- `POST /api/v1/device-calls` — body `{ phone, deviceCallTimestamp }`, auth via existing `firebaseAuth` (reads `req.staff.clinicId/staffId/doctorId`), calls `handleDeviceMissedCall`. Mount in `src/routes/api-v1.js` next to the other `router.use("/x", ...)` lines, following the exact same file-per-resource pattern as `api-v1-call-logs.js`.
- `GET/POST/DELETE /api/v1/caller-whitelist` — CRUD for `CallerWhitelist`, same shape as `api-v1-phone-routes.js` (read for any logged-in staff, write gated by `requireRole("owner")` to start — loosen later if Shikhar wants receptionists managing it themselves).

Update `docs/openapi.yaml` for both new routes, matching the existing doc style — this repo serves interactive docs at `/docs` and clearly treats that as maintained, not optional.

### 4.4 Whitelist UI

Don't build a separate native settings screen for this — it's exactly the kind of small CRUD list the existing design system already has components for (`Field`, `Input`, `Button`, `Sheet` — see `src/components/ui/`). Add a "Missed-call whitelist" card to the existing Automations page (`src/app/(app)/automations/page.tsx`), next to the workflow list, using `useCallerWhitelist`-style hooks matching the existing `usePhoneRoutes` pattern in that same file. This keeps zero new visual language and ships to the APK automatically since the shell just displays the live site. Note: Automations is currently gated `ownerOnly` in the bottom-dock nav (`src/app/(app)/layout.tsx`) — decide with Shikhar whether whitelist management should be usable by receptionist-role staff (who are more likely to be the ones actually fielding these calls) even though the rest of Automations stays owner-only; default to owner-only if unsure, it's a one-line change to loosen later.

The native plugin should cache the whitelist locally (via `@capacitor/preferences`, refreshed on app resume) so missed-call detection doesn't need a network round-trip before deciding whether to log — fetch once, refresh periodically/on-resume, and always let the backend be the final source of truth (a stale local cache just means an occasional over- or under-log, never a security issue, since whitelist membership only affects whether a WhatsApp message gets sent, not any access control).

### 4.5 Build, signing, distribution

- Generate a release keystore (`keytool`), document exactly how it's stored (this is a real secret — do not commit it; note it in `.gitignore` explicitly).
- `./gradlew assembleRelease` (or `bundleRelease` if you ever do go through Play later, but for sideload, `assembleRelease` → signed APK is what's needed).
- Version via `versionCode`/`versionName` in `android/app/build.gradle`.
- Since this isn't going through Play, plan for how updates actually reach clinic phones — simplest: host the APK at a stable URL (could be as simple as a Supabase Storage public bucket, or a route on the existing backend) and put an in-app "check for update" comparing `versionCode` against a small backend-served config value, since there's no Play Store auto-update mechanism here.

## 5. Explicit non-goals for this build

- No outbound calling / callback automation — Shikhar's own words: "we'll figure that out later." WhatsApp only.
- No Play Store listing, no default-dialer role.
- No native UI rebuild — the APK is a shell around the live web app, not a parallel app.
- No changes to the existing Twilio/carrier-forwarding missed-call path — this is additive, not a replacement.

## 6. Verification checklist (put this at the end of the build, as a manual test pass)

- Missed call from a number not in the phone's contacts and not whitelisted → backend receives it, Patient auto-created, WhatsApp send fires, shows up in dashboard History.
- Missed call from a saved contact, not whitelisted → nothing happens.
- Missed call from a saved contact that IS on the whitelist → treated like unknown, logged and messaged.
- Answered call (never rings through to idle-from-ringing) → never fires.
- Airplane mode during a missed call, then reconnected later → WorkManager retry delivers it once connectivity returns, no duplicate.
- Kill the app from recents, then receive a missed call → still detected (this is the manifest-receiver's whole reason for existing — test it explicitly, and test again after a device reboot).
- Same missed call reported twice (simulate a receiver double-fire) → idempotency unique index prevents a duplicate WhatsApp send.

---

# COPY EVERYTHING BELOW THIS LINE INTO A FRESH CLAUDE CODE SESSION

You are building a sideloadable Android APK for ScheduRx, an AI-powered clinic receptionist platform. Two repositories are attached: `schedurx-backend` (Node/Express + Supabase) and `schedurx-platform-v3-mvp-design` (Next.js 14 dashboard, deployed and live). Read both READMEs fully before writing any code.

**The feature:** a missed-call safety net. Install this APK on the phone a clinic's staff member actually takes patient calls on. It watches the phone's native call log in real time via the `READ_CALL_LOG` permission. When a call goes unanswered from a number that is NOT in the phone's contacts (or is a known contact someone has explicitly whitelisted for this), the app reports it to the backend, which auto-creates a Patient/lead record and fires ScheduRx's existing `missed_call_followup` WhatsApp automation — the same one already wired up for the Twilio call-forwarding path. Calls from known, non-whitelisted contacts are never logged. Outbound calling back the patient is explicitly out of scope — WhatsApp only, for now.

**Before writing anything, read these files in full — this feature is largely already half-built on the backend, do not duplicate what's there:**
- `schedurx-backend/src/routes/webhooks-twilio.js` — read the `triggerMissedCallFollowup` function at the bottom. This is the send logic you'll reuse.
- `schedurx-backend/src/services/clinic-service.js` — the `missed_call_followup` default workflow (`DEFAULT_COMMUNICATION_WORKFLOWS`) and its real Content Template SID.
- `schedurx-backend/src/services/messaging-service.js` — `sendTemplatedMessage`.
- `schedurx-backend/src/services/table-service.js` — `findOrCreatePatient` / `findPatientByPhone`.
- `schedurx-backend/src/services/call-log-service.js`, `src/routes/api-v1-call-logs.js`, and the `CallLog` table migration (`supabase/migrations/20260808_call_logs.sql`, plus `20260818_twilio_comms.sql` which adds `twilioCallSid`).
- `schedurx-backend/src/lib/phone.js` — `normalizeIndianMobile`, use it at every boundary.
- `schedurx-backend/src/middleware/firebase-auth.js` and `src/routes/api-v1.js` — how `/api/v1/*` routes get `req.staff`, and how routers get mounted.
- `schedurx-backend/src/routes/api-v1-phone-routes.js` — the CRUD-router shape to copy for the new whitelist endpoint.
- `schedurx-platform-v3-mvp-design/DESIGN_SOURCE.md` and `src/app/globals.css` — the visual system (warm off-white canvas, stone/taupe surfaces, one vivid orange accent, charcoal ink; full CSS custom-property palette in `globals.css`).
- `schedurx-platform-v3-mvp-design/src/app/(app)/automations/page.tsx` — note `missed_call_followup` is ALREADY in the `TRIGGERS` list in the UI; you're wiring up something the frontend already half-expects.
- `schedurx-platform-v3-mvp-design/public/manifest.webmanifest`, `public/icons/` — reuse these, don't design new ones.

**Architecture — decided, don't re-derive:**
- Android shell: Capacitor, configured with a remote `server.url` pointing at the live deployed dashboard origin (ask the user for the exact production URL if it's not obvious from `.env`/deployment config — do not guess a placeholder into the final build). This means the APK shows the literal production web app, unchanged, with zero UI rebuild. Do this as a new `mobile-shell/` folder inside `schedurx-platform-v3-mvp-design/`, with its own `package.json` and `capacitor.config.ts`.
- **Before building anything else, spike-test that a Capacitor project pointed at a remote `server.url` (not a bundled local `webDir`) actually exposes `window.Capacitor` and a custom plugin to that remote page.** This is the one real technical unknown in this whole plan. If it doesn't hold, fall back to a bundled `webDir` shell instead and flag that decision back to the user before proceeding further.
- Distribution is sideload-only — no Play Store, no default-dialer role. This matters because it's *why* `READ_CALL_LOG` is viable at all here.
- Auth: same Firebase login as the web dashboard, per staff member, on their own phone.
- Call detection: a manifest-registered `BroadcastReceiver` on `android.intent.action.PHONE_STATE` (not a persistent foreground service — avoid the notification and extra battery-management friction). On a `RINGING → IDLE` transition (never went `OFFHOOK`), query `CallLog.Calls.CONTENT_URI` directly for the latest row rather than trusting broadcast extras, confirm `TYPE == MISSED_TYPE`, cross-check `ContactsContract` for a known-contact match, cross-check the cached whitelist, dedupe locally, then enqueue a `WorkManager` job to POST it to the backend (offline-safe, retries with backoff).
- Add explicit, design-consistent runtime-permission rationale screens for `READ_CALL_LOG`/`READ_CONTACTS`/`READ_PHONE_STATE`, handle permanent denial gracefully, and add a battery-optimization-exemption request screen — Xiaomi/Vivo/Oppo/OnePlus devices (very common in this app's Bengaluru target market) aggressively kill background receivers otherwise; this is the single biggest real-world reliability risk in this feature, treat it as first-class, not an afterthought.
- **Verify current Android/Play background-execution and permission policy against the live Android developer docs before finalizing the manifest and permission flow** — don't rely solely on prior knowledge here, this area of Android changes release over release and may have moved since your training data.

**Backend changes to make:**
1. New migration (`supabase/migrations/`, follow the existing `YYYYMMDD_description.sql` / `IF NOT EXISTS` convention exactly): extend `CallLog` with `source text NOT NULL DEFAULT 'twilio_ivr'` (check constraint allowing `'twilio_ivr'`/`'android_native'`), `staffId text REFERENCES "Staff"(id)`, `deviceCallTimestamp bigint`, plus a unique index on `(clinicId, phone, "deviceCallTimestamp")` where not null, for idempotency. New table `CallerWhitelist(id, clinicId, phone, label, addedByStaffId, createdAt)`, unique on `(clinicId, phone)`.
2. Extract `triggerMissedCallFollowup` out of `webhooks-twilio.js` into a shared service (recommend `src/services/comms-workflow-service.js`) so both the existing Twilio path and the new device path call the identical function — do not duplicate the send logic.
3. New service function, e.g. `handleDeviceMissedCall(supabaseClient, twilioClient, { clinicId, staffId, doctorId, phone, deviceCallTimestamp }, log)`: normalize phone → idempotency check (swallow conflicts) → `findOrCreatePatient` → write `CallLog` row (`source: 'android_native'`) → call the shared missed-call-followup sender → update the `CallLog` outcome based on send success (`'recovered_missed'` vs `'info'`).
4. New route `POST /api/v1/device-calls` (body `{ phone, deviceCallTimestamp }`, behind existing `firebaseAuth`), and `GET/POST/DELETE /api/v1/caller-whitelist` (writes gated `requireRole("owner")` to start). Mount both in `src/routes/api-v1.js` next to the existing routers, following the one-file-per-resource pattern already used throughout `src/routes/api-v1-*.js`.
5. Update `docs/openapi.yaml` for both new routes.

**Frontend change:** add a small "Missed-call whitelist" CRUD card to the existing Automations page (`src/app/(app)/automations/page.tsx`), reusing the existing `Field`/`Input`/`Button`/`Sheet` components and the `usePhoneRoutes`-style hook pattern already in that file — do not introduce new visual components for this.

**Explicitly out of scope — do not build:** outbound/callback calling, Play Store submission, default-dialer functionality, any change to the existing Twilio/carrier-forwarding missed-call path, any native UI rebuild of the dashboard.

**When you hit a genuine ambiguity** (the production dashboard URL, the Firebase project's exact config values, whether whitelist-editing should be owner-only or open to all staff, the app's package/bundle id, keystore handling) — ask, don't guess a placeholder into a shipped build.

**Definition of done:**
- Signed release APK builds successfully (`./gradlew assembleRelease`) and installs on a physical Android device via sideload.
- Logging into the app shows the live ScheduRx dashboard, pixel-identical to the web version.
- Permission flow requests call log/contacts/phone-state with a clear, on-brand rationale screen, and a battery-optimization-exemption prompt.
- A real missed call from a number outside the phone's contacts, on a physical device, results in: a new `CallLog` row (`source: 'android_native'`) visible in the dashboard History tab, a new/matched Patient record, and a delivered WhatsApp message — verified end to end, not just unit-tested.
- A missed call from an existing, non-whitelisted contact produces no backend call at all.
- The whitelist CRUD card works from the dashboard (web and inside the APK) and is honored by the on-device detection logic.
- All new backend code follows this repo's existing conventions exactly: services hold logic, routes stay thin, every optional integration degrades gracefully, migrations are idempotent, phone numbers are normalized at every boundary.
