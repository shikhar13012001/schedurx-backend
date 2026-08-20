# ScheduRx Backend

Node/Express API for ScheduRx — patients, doctors, appointments, queue, visits,
messaging, billing, and analytics, backed by Supabase Postgres and
[nettu-scheduler](https://github.com/fmeringdal/nettu-scheduler) for real
calendar conflict detection. Three integration surfaces live in one process:

- **`/tools/*`** — machine-facing, called by the voice IVR agent (bearer `TOOLS_API_KEY`).
- **`/internal/*`** — server-to-server, called by sibling services for call-context resolution and clinic/staff bootstrap (bearer `INTERNAL_API_KEY`).
- **`/api/v1/*`** — the browser-facing dashboard REST API, gated by Firebase ID tokens (see [Auth](#auth)). Only mounted when Firebase Admin is configured.

Every optional integration (Firebase, Stripe, OpenAI) degrades gracefully: if
its env vars are missing (or misconfigured), the app still boots — the
surface it powers is just unmounted or returns a clear "not configured" error
instead of crashing the whole process.

## Requirements

- Node.js ≥ 18.18 (droplet runs Node 22)
- A Supabase project (Postgres + Storage)
- A running nettu-scheduler instance (self-hosted or cloud)
- A Firebase project (for staff auth) — same project as the frontend

## Setup

```bash
npm install
cp .env.example .env   # fill in real values — see comments in the file
npm test                # 45 tests, no external services required (all stubbed)
npm run dev              # http://localhost:4000, restarts on file change
```

Interactive API docs are served at `/docs` (Swagger UI over `docs/openapi.yaml`).

### One-time setup scripts

```bash
npm run setup:clinic-calendar     # creates the nettu-scheduler service + per-doctor calendars
npm run setup:storage-bucket      # creates the private "rx-attachments" Storage bucket
```

Both are idempotent — safe to re-run.

### Database migrations

Plain `.sql` files in `supabase/migrations/`, applied in filename order. There
is no migration runner in this repo (no CLI tool takes a direct dependency);
apply them with `psql`, the Supabase SQL Editor, or any Postgres client
against your project's connection string. Every migration uses
`CREATE TABLE IF NOT EXISTS` / `ADD COLUMN IF NOT EXISTS` / `DROP CONSTRAINT IF
EXISTS`, so re-running the full set is always safe.

See `docs/live-schema-baseline.md` for a snapshot of tables that predate this
repo's migrations, and dormant tables that intentionally aren't touched.

## Environment variables

See `.env.example` — every variable is documented inline, including which
integration it gates and what happens when it's left unset. Two forms worth
calling out:

- **`FIREBASE_PRIVATE_KEY_BASE64`** is preferred over `FIREBASE_PRIVATE_KEY`
  on any platform whose env-loader mangles literal `\n` sequences (notably
  systemd's `EnvironmentFile`, used by the droplet deploy below). It takes
  precedence when both are set.
- **`CORS_ALLOWED_ORIGIN`** takes a comma-separated allowlist of origins (e.g.
  a local dev origin and a deployed frontend domain at once). `/api/v1` has no
  CORS headers at all until this is set.

## Testing

```bash
npm test           # node:test, all stubbed — no network calls
npm run lint        # ESLint
npm run format:check
npm run verify      # lint + format:check + test — the pre-deploy gate
```

## Deployment

**Current production**: a systemd service (`schedurx-backend.service`) on a
DigitalOcean droplet, running `node src/server.js` directly (no container).
That droplet also runs the live IVR voice agent as a separate systemd unit —
never restart that one from here. Deploy flow: sync changed files, `npm ci`
if `package.json` changed, `systemctl restart schedurx-backend.service`,
confirm `GET /health`.

**Alternative — Render**: `render.yaml` at the repo root defines a Render web
service (`npm ci` → `npm start`, health check on `/health`). Not the current
live deployment; kept as a ready-to-use alternative.

**Alternative — Docker**: a `Dockerfile` is provided (`node:22-slim`, runs as
non-root). Not build-verified in this environment (no Docker daemon
available at the time it was added) — verify with `docker build .` before
relying on it. It is not the current deployment path.

Before any deployment, read **`PRODUCTION_CHECKLIST.md`** — several items
there (a stray service-account key file, CORS being single-origin, no TLS on
the droplet's IP-only endpoint) are real, unresolved gaps, not hypothetical
ones.

## Project structure

```
src/
  app.js              # route mounting, in dependency-injected client order
  server.js            # builds real clients (Supabase/nettu/Firebase/Stripe/OpenAI), starts the HTTP server
  config.js            # env var parsing/validation (zod)
  middleware/           # firebase-auth, bearer-auth, error-handler, require-role
  routes/
    api-v1-*.js          # dashboard REST routes (one file per resource)
    tools.js, *.js        # voice-agent-facing tool routes
    internal-*.js          # server-to-server routes
  services/             # business logic + Supabase/nettu/OpenAI/Stripe calls — routes stay thin
supabase/migrations/    # plain SQL, applied in filename order
scripts/                 # one-time idempotent setup scripts
docs/
  openapi.yaml           # served at /docs
  live-schema-baseline.md
test/
  api/app.test.js         # integration tests against createApp() with stubbed clients
  services/                # unit tests
  helpers/                  # supabase/firebase/stripe/openai stubs
```

## Adding a new integration (payment provider, storage backend, etc.)

Follow the existing seam: a `build*Client()` factory in `server.js` (wrapped
in try/catch — a bad credential must degrade like a missing one, never crash
the process), a service module under `src/services/` that takes the client as
a parameter (never imports a singleton), and a route file that stays thin —
translating HTTP in/out, no business logic. Mount conditionally in `app.js`/
`api-v1.js` only when the client is present, matching the `nettuClient`/
`stripeClient`/`openaiClient` pattern already there.
