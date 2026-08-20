# Production checklist

Status as of this writing — a full re-verification pass, not a rewrite from assumption. Several items below have moved from the previous version of this checklist (some fixed, some found stale — see "Verified stale/already-resolved" at the bottom). Items are ordered by risk, not by effort.

## 🔴 Do before anything else

- [ ] **No TLS.** The droplet is served over plain HTTP on a bare IP
      (`http://139.59.34.211:4000`). Firebase ID tokens and Stripe data are
      currently sent over an unencrypted connection between browser and
      server. Put this behind a domain + TLS (Caddy/nginx + Let's Encrypt, or
      a managed load balancer) before any real patient data flows through it.
- [ ] **This directory has no `.git` yet.** Nothing is version-controlled —
      no history, no rollback path, no code review trail. `git init` + an
      initial commit (`.gitignore` already keeps secrets out, and the stray
      Firebase service-account key file that used to sit in the repo root has
      been deleted this pass) should happen early, not as an afterthought.

## 🟠 Real gaps, not hypothetical

- [ ] **AI Practice Pulse / triage / recap all share one OpenAI account's
      billing.** If credits run out, `GET /api/v1/analytics/practice-pulse`,
      `/api/v1/ai/triage`, and the Consults recap flow all degrade to a `502`/
      `503` rather than crash (verified in `test/api/app.test.js`) — but
      confirm the account actually has credit before relying on any of them.
      No code change needed, just an account check.
- [ ] **Call logs stay empty until a separate service calls
      `POST /tools/call-logs`.** Verified this pass: the Twilio voice webhooks
      (`/webhooks/twilio/voice`, `/voice-status`) never insert a new `CallLog`
      row themselves — `/voice-status` only _updates_ one that already
      exists, by `twilioCallSid`. The intended writer is a live voice agent
      (`schedurx-calling-agent`, a separate repo) calling `POST
    /tools/call-logs` after each call; until that's wired up, real inbound
      calls won't populate call history even though the read side (`GET
    /api/v1/call-logs`) and the write endpoint itself are both real and
      tested.
- [ ] **Only one real Staff account exists** beyond the seed test row
      (`test-owner@example.com`). New-clinic self-serve onboarding is real on
      both sides now — the dashboard's `/onboarding` flow correctly calls
      through to this backend's `POST /internal/clinic` (a real,
      previously-broken bug in the frontend's proxy routing was found and
      fixed this session) — but every doctor/receptionist who needs to sign
      in for real still needs either that onboarding flow or a
      `POST /internal/staff` call first (see README).
- [ ] **Dockerfile and `docker build .` are still unverified** — no Docker
      daemon available in this environment on any pass so far. Run a real
      build + smoke test before treating it as a real deployment option.
- [ ] **Supabase Storage bucket (`rx-attachments`, `clinic-voice`) have no
      lifecycle/retention policy** — Rx photos, generated PDFs, and cached
      voice greetings accumulate indefinitely. Decide a retention policy if
      storage cost or compliance requires one.

## 🟡 Worth doing, lower urgency

- [ ] **`npm audit`: 6 moderate vulnerabilities remain**, down from 8 this
      pass (`firebase-admin` bumped 13→14, along with the modular-API
      migration that bump actually requires — see below). The residual is a
      transitive `uuid` bounds-check finding through
      `firebase-admin`'s `@google-cloud/storage`/`@google-cloud/firestore`
      dependency chain — this backend only uses `firebase-admin/auth`, never
      Firestore or Cloud Storage via the Admin SDK, so the vulnerable code
      path is unreachable in practice. No newer firebase-admin version
      currently resolves it fully.
- [ ] **Format-check runs in CI as informational only, not a hard gate**
      (`.github/workflows/ci.yml`, added this pass) — 14 files predate a full
      Prettier pass across the whole repo. Flip to blocking once that's done.
- [ ] **No process manager beyond systemd's own restart policy** — confirm
      `Restart=on-failure` (or similar) is set in the unit file, and that
      logs are shipped somewhere durable (currently `journalctl` only, which
      rotates).

## Fixed this pass

- **Firebase Admin SDK migrated 13→14** (`src/server.js` +
  `src/middleware/firebase-auth.js` + `src/services/staff-invite-service.js`
  - `src/routes/internal-{staff,clinic}-onboarding.js` + the matching test
    stubs). This is the _actual code change_ the previous checklist's "requires
    a real upgrade to plan and test deliberately" note anticipated but hadn't
    done: v14's legacy `require("firebase-admin")` namespaced import no longer
    exposes `admin.credential.cert` at all (`TypeError: Cannot read properties
of undefined`, confirmed live against real credentials before touching any
    route code) — replaced with the modular `cert`/`initializeApp` from
    `firebase-admin/app` and `getAuth` from `firebase-admin/auth`, resolved
    once at boot rather than per-call-site. Verified live end-to-end afterward
    with real Firebase credentials: `initializeApp` → `getAuth` → the auth
    middleware's real `verifyIdToken` call all execute correctly, and all 157
    tests still pass.
- **Stray Firebase service-account JSON key file deleted** from the repo
  root (confirmed unused by any code path both by the previous checklist
  pass and independently this pass — the app only ever reads credentials
  from `FIREBASE_PRIVATE_KEY_BASE64`/`FIREBASE_PRIVATE_KEY`).
- **Rate limiting added to `/api/v1`, `/tools`, and `/tools/debug/echo`** —
  previously only `/api/v1/public` had it. Reused the same in-memory
  per-IP `middleware/rate-limit.js` already built for that router. Verified
  live: 300/min on `/api/v1`, 120/min on `/tools`, 30/min on the fully
  unauthenticated debug echo route — confirmed a real 429 kicks in past the
  ceiling.
- **CI added** (`.github/workflows/ci.yml`) — lint, test, and an OpenAPI
  spec parse-check run on every push/PR to `main`.
- **OpenAPI spec brought up to date** — grew from 40 to 74 documented paths.
  Everything built across this whole project that was missing is now in
  `docs/openapi.yaml` and live at `/docs` (Swagger UI, verified serving real
  data): the entire `/api/v1/public/*` patient-facing booking API, the
  in-app AI assistant (`/api/v1/assistant`, `/speak`), media transcription,
  visit attachments/recap, call/WhatsApp logs, phone routing, per-item
  notification actions, analytics utilization/practice-pulse, team invites,
  the staff-invite bootstrap endpoints, all four `/webhooks/twilio/*`
  routes, `/webhooks/nettu-reminders`, and `/tools/call-logs`.
- **`render.yaml` and `.env.example` brought up to date** — both were
  missing `TWILIO_*`, `ELEVENLABS_*`, `APP_BASE_URL`,
  `PUBLIC_CORS_ALLOWED_ORIGIN`, and `NETTU_WEBHOOK_KEY`, all real,
  currently-used config added well after these files were first written.

## Verified stale / already-resolved (no action needed)

The previous version of this checklist had several items independently
re-checked and found no longer accurate — noted here rather than silently
dropped, since disappearing checklist items with no explanation invite the
same stale-doc problem right back:

- ~~`CORS_ALLOWED_ORIGIN` supports exactly one origin~~ — already
  comma-separated/array-capable in `app.js` (both the staff-dashboard and
  `/api/v1/public` CORS blocks), evidently fixed in an earlier pass this
  checklist didn't get updated to reflect.
- ~~WhatsApp is fully stubbed~~ — real Twilio WhatsApp sending
  (`twilio-client.js`) has been live and verified extensively since this
  checklist item was written. `whatsapp-client.js`'s stub still exists, but
  only as the intentional fallback for a deployment that hasn't configured
  Twilio at all — not the active code path in production, where Twilio _is_
  configured.
- ~~New-clinic signup is deferred by design~~ — real now on both sides (see
  the still-open Staff-accounts item above for the current, narrower state).

## Already solid (re-confirmed this pass)

- Every optional integration (Firebase, Stripe, OpenAI, nettu, Twilio,
  ElevenLabs) degrades to "unmounted" or a clear error rather than crashing
  the process when unconfigured or misconfigured — regression-tested in
  `test/api/app.test.js`.
- 157/157 tests pass.
- `GET /docs` (Swagger UI) and `GET /docs/openapi.json` both serve live,
  parse correctly, and reflect the real current route surface.
