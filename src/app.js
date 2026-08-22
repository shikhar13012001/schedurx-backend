const express = require("express");
const helmet = require("helmet");
const pinoHttp = require("pino-http");
const { config } = require("./config");
const { logger } = require("./logger");
const { bearerAuth } = require("./middleware/bearer-auth");
const { createRateLimiter } = require("./middleware/rate-limit");
const { errorHandler } = require("./middleware/error-handler");
const { createToolsRouter } = require("./routes/tools");
const { createInternalCallContextRouter } = require("./routes/internal-call-context");
const { createInternalStaffOnboardingRouter } = require("./routes/internal-staff-onboarding");
const { createInternalClinicOnboardingRouter } = require("./routes/internal-clinic-onboarding");
const { createApiV1Router } = require("./routes/api-v1");
const { createApiV1PublicRouter } = require("./routes/api-v1-public");
const { createStripeWebhookRouter } = require("./routes/stripe-webhook");
const { createNettuWebhookRouter } = require("./routes/webhooks-nettu");
const { createTwilioWebhookRouter } = require("./routes/webhooks-twilio");
const { mountDocs } = require("./docs");

function createApp({
  supabaseClient,
  nettuClient,
  firebaseAdminApp,
  stripeClient,
  openaiClient,
  assistantModel,
  twilioClient,
  elevenLabsClient,
}) {
  const app = express();
  app.set("trust proxy", config.trustProxy);

  // CSP off: this is a JSON API (plus /docs' Swagger UI, which needs inline
  // script/style CSP would break) — the meaningful headers here are HSTS,
  // nosniff, and disabling framing, not a content policy for HTML we don't
  // serve. HSTS is a no-op over plain HTTP, so this is safe to enable before
  // TLS is actually terminated in front of this app.
  app.use(helmet({ contentSecurityPolicy: false }));

  app.use(
    pinoHttp({
      logger,
      genReqId(request) {
        return request.headers["x-request-id"] || undefined;
      },
    }),
  );

  // Stripe webhook needs the untouched request body for signature verification,
  // so it's mounted (with its own express.raw() parser, applied inside the
  // router itself) BEFORE express.json() below ever runs on the request.
  if (stripeClient) {
    app.use("/webhooks/stripe", createStripeWebhookRouter(supabaseClient, stripeClient));
  }

  // Twilio's signature check needs the parsed application/x-www-form-urlencoded
  // body (not raw bytes like Stripe, and not JSON) plus the exact request URL,
  // so it gets its own scoped urlencoded() parser here — same "before the
  // global parser" placement as Stripe, for the same reason: the global
  // express.json() below would never even attempt to parse Twilio's
  // form-encoded body, but mounting order still keeps every webhook's parsing
  // concern local to itself rather than leaking into the shared pipeline.
  if (twilioClient) {
    app.use(
      "/webhooks/twilio",
      express.urlencoded({ extended: false }),
      createTwilioWebhookRouter({
        supabaseClient,
        twilioClient,
        nettuClient,
        assistantModel,
        openaiClient,
        elevenLabsClient,
      }),
    );
  }

  // 15mb (up from the default 100kb) so the voice-recap/transcribe routes can
  // carry a base64 audio clip in a plain JSON body — a second, path-scoped
  // express.json() layered in front of this one doesn't work the way
  // Stripe/Twilio's raw-parser-then-terminate pattern does: those routers end
  // the request themselves before ever reaching this middleware, but a bare
  // parser calls next() and falls through, so a second json() here would just
  // re-read the already-drained body stream and wipe it back to `{}`.
  app.use(express.json({ limit: "15mb" }));

  // Reminder callbacks from nettu-scheduler — see scripts/setup-nettu-webhook.js
  // for the one-time registration this key comes from. No signature scheme
  // beyond the static header key nettu echoes back, so plain express.json()
  // (already mounted above) is fine here, unlike Stripe's webhook.
  if (config.NETTU_WEBHOOK_KEY) {
    app.use(
      "/webhooks/nettu-reminders",
      createNettuWebhookRouter(supabaseClient, config.NETTU_WEBHOOK_KEY, twilioClient),
    );
  }

  app.get("/health", (request, response) => {
    response.json({
      ok: true,
      service: "schedurx-backend",
      timestamp: new Date().toISOString(),
    });
  });

  // Unconditional — no client/env var gates the API docs themselves.
  mountDocs(app);

  // No-auth echo tool — registered BEFORE bearerAuth so Ultravox can call it without a key.
  // Use this to inspect exactly what Ultravox sends (headers + body) during a tool call.
  // Rate-limited since it's the one route on this server with no auth at all.
  const debugEchoLimiter = createRateLimiter({ windowMs: 60_000, max: 30 });
  app.post("/tools/debug/echo", debugEchoLimiter, (request, response) => {
    const payload = { headers: request.headers, body: request.body };
    request.log.info(payload, "[tool:debug] echo invoked");
    response.json({
      message: "Echo received. Check server logs for full request details.",
      received: payload,
    });
  });

  // A leaked/compromised TOOLS_API_KEY previously had no request-rate ceiling —
  // generous enough for a live voice call's normal handful of tool calls, low
  // enough to blunt abuse of a leaked key.
  const toolsLimiter = createRateLimiter({ windowMs: 60_000, max: 120 });
  app.use(
    "/tools",
    toolsLimiter,
    bearerAuth(config.TOOLS_API_KEY),
    createToolsRouter(supabaseClient, nettuClient, twilioClient),
  );

  // Called by schedurx-ultravox-demo-api only — never by Ultravox directly.
  app.use(
    "/internal/call-context",
    bearerAuth(config.INTERNAL_API_KEY),
    createInternalCallContextRouter(supabaseClient),
  );

  // Bootstrap-only: creates a Staff row + sets Firebase custom claims.
  if (firebaseAdminApp) {
    app.use(
      "/internal/staff",
      bearerAuth(config.INTERNAL_API_KEY),
      createInternalStaffOnboardingRouter(supabaseClient, firebaseAdminApp),
    );
  }

  // Bootstrap-only: creates a Clinic (+ nettu calendars) and its owner Staff row.
  if (firebaseAdminApp) {
    app.use(
      "/internal/clinic",
      bearerAuth(config.INTERNAL_API_KEY),
      createInternalClinicOnboardingRouter(supabaseClient, nettuClient, firebaseAdminApp),
    );
  }

  // Unauthenticated patient-facing booking API — schedurx-form-agent's real
  // client. Registered BEFORE the /api/v1 block below: both routers are
  // mounted on overlapping path prefixes ("/api/v1/public/..." also matches
  // "/api/v1"), and Express dispatches to whichever matching middleware was
  // registered first, so this must come first to avoid ever reaching
  // /api/v1's firebaseAuth gate. Own CORS allowlist, separate from the
  // staff-dashboard one below — the patient frontend's origin (APP_BASE_URL)
  // is always allowed in addition to whatever PUBLIC_CORS_ALLOWED_ORIGIN adds.
  {
    const publicOrigins = [config.APP_BASE_URL, ...(config.PUBLIC_CORS_ALLOWED_ORIGIN?.split(",") ?? [])]
      .map((origin) => origin?.trim())
      .filter(Boolean);
    if (publicOrigins.length) {
      const cors = require("cors");
      app.use(
        "/api/v1/public",
        cors({
          origin(origin, callback) {
            if (!origin || publicOrigins.includes(origin)) return callback(null, true);
            return callback(new Error(`Origin '${origin}' is not allowed`));
          },
        }),
      );
    }
    app.use("/api/v1/public", createApiV1PublicRouter(supabaseClient, nettuClient, twilioClient));
  }

  // Dashboard REST API — the browser-facing surface, so CORS applies here only
  // (never to /tools or /internal, which are server-to-server).
  if (firebaseAdminApp) {
    if (config.CORS_ALLOWED_ORIGIN) {
      const cors = require("cors");
      // Comma-separated allowlist, e.g. "http://localhost:3000,https://app.schedurx.in" —
      // lets a local dev origin and a deployed frontend domain both work at once.
      const allowedOrigins = config.CORS_ALLOWED_ORIGIN.split(",")
        .map((origin) => origin.trim())
        .filter(Boolean);
      app.use(
        "/api/v1",
        cors({
          origin(origin, callback) {
            // No Origin header (curl, server-to-server) — allow.
            if (!origin || allowedOrigins.includes(origin)) return callback(null, true);
            return callback(new Error(`Origin '${origin}' is not allowed`));
          },
        }),
      );
    }
    // A leaked/compromised Firebase ID token previously had no request-rate
    // ceiling — generous enough for normal heavy dashboard use (multiple
    // staff/tabs sharing one clinic's IP, queue polling, etc.).
    app.use("/api/v1", createRateLimiter({ windowMs: 60_000, max: 300 }));
    app.use(
      "/api/v1",
      createApiV1Router({
        supabaseClient,
        nettuClient,
        firebaseAdminApp,
        stripeClient,
        openaiClient,
        assistantModel,
        twilioClient,
        elevenLabsClient,
      }),
    );
  }

  app.use(errorHandler);

  return app;
}

module.exports = { createApp };
