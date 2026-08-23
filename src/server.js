const { createClient } = require("@supabase/supabase-js");
const { config } = require("./config");
const { logger } = require("./logger");
const { NettuClient } = require("./services/nettu-client");
const { createApp } = require("./app");

// Every client below follows the same shape nettuClient already established:
// constructed only if its required env vars are all present, else null — never
// throws at boot. app.js mounts each dependent router only `if (client)`.

// A misconfigured integration (present but invalid credentials) must degrade
// exactly like a missing one — log and disable that feature — never throw out
// of start() and take /tools and /health down with it. Each builder below is
// self-contained specifically so one bad key can't crash the whole process.
// See config.js's comments on FIREBASE_PRIVATE_KEY vs FIREBASE_PRIVATE_KEY_BASE64 —
// the base64 form is preferred wherever it's available.
function resolveFirebasePrivateKey() {
  if (config.FIREBASE_PRIVATE_KEY_BASE64) {
    return Buffer.from(config.FIREBASE_PRIVATE_KEY_BASE64, "base64").toString("utf8");
  }
  if (config.FIREBASE_PRIVATE_KEY) {
    return config.FIREBASE_PRIVATE_KEY.replace(/\\n/g, "\n");
  }
  return null;
}

function buildFirebaseAdminApp() {
  const privateKey = resolveFirebasePrivateKey();
  if (!config.FIREBASE_PROJECT_ID || !config.FIREBASE_CLIENT_EMAIL || !privateKey) {
    logger.warn("[startup] Firebase Admin not configured — /api/v1 disabled");
    return null;
  }
  try {
    // Modular API (firebase-admin v14+) — the legacy `require("firebase-admin")`
    // namespaced import's `admin.credential` is undefined on this version.
    // Resolved to the Auth service once here (not the raw App) — every call
    // site downstream (firebase-auth.js, staff-invite-service.js, the two
    // internal onboarding routes) calls `.verifyIdToken`/`.setCustomUserClaims`
    // directly on what's passed in as `firebaseAdminApp`, same shape as
    // before's `app.auth()`, no per-call-site `getAuth()` needed. This also
    // keeps test/helpers/firebase-admin-stub.js a plain object rather than
    // needing to satisfy the real SDK's internal App machinery.
    const { cert, initializeApp } = require("firebase-admin/app");
    const { getAuth } = require("firebase-admin/auth");
    const app = initializeApp({
      credential: cert({
        projectId: config.FIREBASE_PROJECT_ID,
        clientEmail: config.FIREBASE_CLIENT_EMAIL,
        privateKey,
      }),
    });
    return getAuth(app);
  } catch (err) {
    logger.error({ err }, "[startup] Firebase Admin credentials invalid — /api/v1 disabled");
    return null;
  }
}

function buildStripeClient() {
  if (!config.STRIPE_SECRET_KEY) {
    logger.warn("[startup] Stripe not configured — /api/v1/billing checkout + /webhooks/stripe disabled");
    return null;
  }
  try {
    const Stripe = require("stripe");
    return new Stripe(config.STRIPE_SECRET_KEY);
  } catch (err) {
    logger.error(
      { err },
      "[startup] Stripe client construction failed — /api/v1/billing checkout + /webhooks/stripe disabled",
    );
    return null;
  }
}

function buildOpenaiClient() {
  if (!config.OPENAI_API_KEY) {
    logger.warn("[startup] OpenAI not configured — /api/v1/ai disabled");
    return null;
  }
  try {
    const { OpenAI } = require("openai");
    return new OpenAI({ apiKey: config.OPENAI_API_KEY });
  } catch (err) {
    logger.error({ err }, "[startup] OpenAI client construction failed — /api/v1/ai disabled");
    return null;
  }
}

function buildAssistantModel() {
  if (!config.OPENAI_API_KEY) {
    logger.warn("[startup] OpenAI not configured — /api/v1/assistant disabled");
    return null;
  }
  try {
    const { createOpenAI } = require("@ai-sdk/openai");
    return createOpenAI({ apiKey: config.OPENAI_API_KEY })(config.OPENAI_MODEL);
  } catch (err) {
    logger.error({ err }, "[startup] Assistant model construction failed — /api/v1/assistant disabled");
    return null;
  }
}

function buildElevenLabsClient() {
  if (!config.ELEVENLABS_API_KEY) {
    logger.warn("[startup] ElevenLabs not configured — voice synthesis (Ask ScheduRx speech, greeting audio) disabled");
    return null;
  }
  try {
    const { createElevenLabsClient } = require("./services/elevenlabs-client");
    return createElevenLabsClient({ apiKey: config.ELEVENLABS_API_KEY, voiceId: config.ELEVENLABS_VOICE_ID });
  } catch (err) {
    logger.error({ err }, "[startup] ElevenLabs client construction failed — voice synthesis disabled");
    return null;
  }
}

function buildTwilioClient() {
  if (!config.TWILIO_ACCOUNT_SID || !config.TWILIO_AUTH_TOKEN) {
    logger.warn("[startup] Twilio not configured — /webhooks/twilio/* disabled");
    return null;
  }
  try {
    const { createTwilioClient } = require("./services/twilio-client");
    return createTwilioClient({
      accountSid: config.TWILIO_ACCOUNT_SID,
      authToken: config.TWILIO_AUTH_TOKEN,
      smsFrom: config.TWILIO_SMS_FROM,
      whatsappFrom: config.TWILIO_WHATSAPP_FROM,
    });
  } catch (err) {
    logger.error({ err }, "[startup] Twilio client construction failed — /webhooks/twilio/* disabled");
    return null;
  }
}

function registerShutdownHandlers(server) {
  const shutdown = (signal) => {
    logger.info({ signal }, "Shutdown requested");

    server.close((error) => {
      if (error) {
        logger.error({ err: error }, "Failed to close server cleanly");
        process.exit(1);
      }

      logger.info("Server stopped");
      process.exit(0);
    });

    setTimeout(() => {
      logger.error({ signal }, "Forced shutdown after timeout");
      process.exit(1);
    }, 10_000).unref();
  };

  process.once("SIGINT", () => shutdown("SIGINT"));
  process.once("SIGTERM", () => shutdown("SIGTERM"));
}

async function start() {
  const supabaseClient = createClient(config.SUPABASE_URL, config.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const nettuClient = new NettuClient({
    baseUrl: config.NETTU_BASE_URL,
    apiKey: config.NETTU_API_KEY,
    logger,
  });

  const firebaseAdminApp = buildFirebaseAdminApp();
  const stripeClient = buildStripeClient();
  const openaiClient = buildOpenaiClient();
  const assistantModel = buildAssistantModel();
  const twilioClient = buildTwilioClient();
  const elevenLabsClient = buildElevenLabsClient();

  const app = createApp({
    supabaseClient,
    nettuClient,
    firebaseAdminApp,
    stripeClient,
    openaiClient,
    assistantModel,
    twilioClient,
    elevenLabsClient,
  });
  const server = app.listen(config.PORT, () => {
    logger.info({ port: config.PORT }, "Server listening");
  });

  // Pay-first token bookings (Phase 3) hold a real nettu-scheduler slot the
  // moment checkout starts — if a patient abandons Stripe's payment page,
  // nothing else would ever release that hold. .unref() so this timer alone
  // never keeps the process alive (process.exit() in registerShutdownHandlers
  // below already terminates unconditionally regardless of pending timers).
  const appointmentSvc = require("./services/appointment-service");
  setInterval(() => {
    appointmentSvc.expirePendingBookings(nettuClient, supabaseClient, logger).catch((err) => {
      logger.error({ err }, "[startup] expirePendingBookings tick failed");
    });
  }, 5 * 60_000).unref();

  registerShutdownHandlers(server);
}

start().catch((error) => {
  logger.fatal({ err: error }, "Failed to start server");
  process.exit(1);
});
