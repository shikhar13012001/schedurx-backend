const { z } = require("zod");

require("dotenv").config();

const schema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().min(1).max(65535).default(4000),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).default("info"),
  TRUST_PROXY: z
    .string()
    .optional()
    .transform((value) => value === "true"),

  // Auth for tools Ultravox calls directly, and for the internal call-context API
  // the demo bridge calls before creating an Ultravox call.
  TOOLS_API_KEY: z.string().min(32),
  INTERNAL_API_KEY: z.string().min(32),

  SUPABASE_URL: z.string().url(),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(1),

  // Nettu-scheduler (nittei) — required for calendar features.
  NETTU_BASE_URL: z.string().url(),
  NETTU_API_KEY: z.string().min(1),
  // Verified against the `nettu-scheduler-webhook-key` header on every
  // POST /webhooks/nettu-reminders call — set once via `PUT /api/v1/account/webhook`
  // on the nettu account (see scripts/ for the one-off setup call), and nettu
  // echoes this exact value back on every reminder webhook it fires.
  // /webhooks/nettu-reminders stays unmounted without it.
  NETTU_WEBHOOK_KEY: z.string().optional(),

  CLINIC_ID: z.string().optional(),

  // ── Firebase Admin (staff auth + RBAC) — /api/v1 stays unmounted unless project id,
  // client email, and one of the two private-key forms below are all set.
  FIREBASE_PROJECT_ID: z.string().optional(),
  FIREBASE_CLIENT_EMAIL: z.string().email().optional(),
  // Literal PEM with \n escapes — works as-is on platforms whose env-var storage
  // doesn't reinterpret backslashes (e.g. Render's dashboard). Some platforms'
  // env-file mechanisms (notably systemd's EnvironmentFile) strip the backslash
  // out of "\n", corrupting this form silently — prefer the _BASE64 var below
  // when deploying anywhere env vars pass through a file-based loader like that.
  FIREBASE_PRIVATE_KEY: z.string().optional(),
  // Base64 of the raw PEM (real newlines, before any escaping) — immune to the
  // escaping quirk above since there's no backslash or newline in the value at
  // all. Takes precedence over FIREBASE_PRIVATE_KEY when both are set.
  FIREBASE_PRIVATE_KEY_BASE64: z.string().optional(),

  // ── Realtime JWT bridge — mints a Supabase-compatible token for browser Realtime
  // subscriptions (QueueItem). Without it, GET /api/v1/realtime-token returns 501 and
  // the dashboard falls back to polling.
  SUPABASE_JWT_SECRET: z.string().optional(),

  // ── Stripe billing — /api/v1/billing and /webhooks/stripe stay unmounted without both.
  STRIPE_SECRET_KEY: z.string().optional(),
  STRIPE_WEBHOOK_SECRET: z.string().optional(),

  // ── Stripe recurring subscription Price ids — real, human-created in the
  // Stripe Dashboard (test mode first), never invented here. Each is
  // independently optional: a clinic can only subscribe to a plan/addon
  // whose Price id is actually set, and the checkout-session route fails
  // gracefully (STRIPE_PRICE_NOT_CONFIGURED, matching STRIPE_NOT_CONFIGURED's
  // shape) for anything still missing rather than fabricating an id.
  STRIPE_PRICE_BASIC: z.string().optional(),
  STRIPE_PRICE_PREMIUM: z.string().optional(),
  STRIPE_PRICE_CUSTOM_BASE: z.string().optional(),
  STRIPE_PRICE_ADDON_ONLINE_CONSULTATIONS: z.string().optional(),
  STRIPE_PRICE_ADDON_SMART_IVR: z.string().optional(),
  STRIPE_PRICE_ADDON_AI_CALLING_AGENT: z.string().optional(),
  STRIPE_PRICE_ADDON_AI_WHATSAPP_AGENT: z.string().optional(),
  STRIPE_PRICE_ADDON_RECORDED_CALL_REMINDERS: z.string().optional(),
  STRIPE_PRICE_ADDON_AI_FOLLOWUP_AGENT: z.string().optional(),
  STRIPE_PRICE_ADDON_AMBIENT_LISTENING: z.string().optional(),
  STRIPE_PRICE_ADDON_PREMIUM_WEBSITE: z.string().optional(),

  // Optional non-default Stripe Billing Portal configuration id (Dashboard >
  // Settings > Billing > Customer portal). Left unset, portal sessions use
  // the account's default configuration.
  STRIPE_PORTAL_CONFIGURATION_ID: z.string().optional(),

  // ── OpenAI — /api/v1/ai stays unmounted without this.
  OPENAI_API_KEY: z.string().optional(),
  OPENAI_MODEL: z.string().default("gpt-4o-mini"),

  // ── Web push (VAPID) — sends no-op (logged) without both keys.
  VAPID_PUBLIC_KEY: z.string().optional(),
  VAPID_PRIVATE_KEY: z.string().optional(),
  VAPID_SUBJECT: z.string().default("mailto:ops@schedurx.example"),

  // ── Dashboard CORS — no CORS middleware applied without it.
  CORS_ALLOWED_ORIGIN: z.string().optional(),

  // ── Twilio (Voice/SMS/WhatsApp) — /webhooks/twilio/* stay unmounted without
  // the first two. One shared platform account, not per-clinic — clinics are
  // distinguished by PhoneNumberRoute, not by separate Twilio credentials.
  TWILIO_ACCOUNT_SID: z.string().optional(),
  TWILIO_AUTH_TOKEN: z.string().optional(),
  // Fallback senders used when a clinic has no PhoneNumberRoute/Clinic.whatsappFrom
  // sender of its own configured for outbound SMS/WhatsApp.
  TWILIO_SMS_FROM: z.string().optional(),
  TWILIO_WHATSAPP_FROM: z.string().optional(),
  // The number a clinic sets up call forwarding TO (see routes/api-v1-onboarding.js's
  // call-forwarding step and lib/call-forwarding.js's dial-code templates).
  // Falls back to TWILIO_WHATSAPP_FROM — the same shared number already
  // answers /webhooks/twilio/voice today — so this only needs setting
  // explicitly if the voice and messaging numbers are ever split apart.
  TWILIO_FORWARDING_NUMBER: z.string().optional(),
  // Optional Meta-approved Content Template for business-initiated team
  // invites. Without it WhatsApp free-form delivery only works when the
  // invitee already has an open 24-hour customer-service window.
  TWILIO_TEAM_INVITE_CONTENT_SID: z.preprocess(
    (value) => (value === "" ? undefined : value),
    z
      .string()
      .regex(/^HX[a-fA-F0-9]{32}$/)
      .optional(),
  ),

  // ── ElevenLabs (voice synthesis) — Ask ScheduRx speaks its replies aloud,
  // and the missed-call greeting upgrades from Twilio's built-in <Say> voice
  // to a cached natural one, without either without this.
  ELEVENLABS_API_KEY: z.string().optional(),
  // "Rachel" — a stable premade ElevenLabs voice — is the default so this
  // works out of the box once just the API key is set; override per-deployment
  // to use a cloned/custom voice instead.
  ELEVENLABS_VOICE_ID: z.string().default("21m00Tcm4TlvDq8ikWAM"),

  // The patient booking app's public origin (no trailing slash), e.g.
  // "https://book.schedurx.com" — used to turn tool-helpers.js's relative
  // formUrl() ("/clinicId/appointmentId") into a real link patients can tap
  // from a booking-confirmation SMS/WhatsApp message. Left unset, those
  // messages just omit the link rather than send a broken relative path.
  //
  // Was a single overloaded APP_BASE_URL until this split — it was also
  // being used for team-invite links (api-v1-team.js), which need the
  // *dashboard's* URL instead. A staff invite pointed at the patient app
  // has no matching route there, so every invite link was silently broken.
  PATIENT_APP_BASE_URL: z.string().optional(),

  // The staff dashboard's public origin, e.g. "https://app.schedurx.com" —
  // used to build team-invite links (api-v1-team.js). Separate from
  // CORS_ALLOWED_ORIGIN (which can list more than one dev/prod origin) since
  // an invite link needs exactly one canonical URL to send.
  DASHBOARD_BASE_URL: z.string().optional(),

  // This backend's own public origin, e.g. "https://api.schedurx.com" — used
  // to build the statusCallback URL attached to every outbound Twilio send
  // (twilio-client.js), so Twilio has somewhere to report real delivery
  // outcomes (see supabase/migrations/20260825_message_log.sql). Left
  // unset, sends still work exactly as before — they just aren't tracked.
  PUBLIC_API_BASE_URL: z.string().optional(),

  // ── Public patient-facing API CORS (/api/v1/public/*) — separate allowlist
  // from CORS_ALLOWED_ORIGIN since that one gates the staff dashboard only.
  // Comma-separated, same format. PATIENT_APP_BASE_URL (the patient app's
  // own origin) is always allowed in addition to whatever's listed here, so
  // this is normally only needed for a local-dev origin that differs from it.
  PUBLIC_CORS_ALLOWED_ORIGIN: z.string().optional(),
});

const parsed = schema.safeParse(process.env);

if (!parsed.success) {
  const issues = parsed.error.issues.map((issue) => `${issue.path.join(".") || "env"}: ${issue.message}`).join("\n");
  throw new Error(`Invalid environment configuration\n${issues}`);
}

const config = {
  ...parsed.data,
  trustProxy: parsed.data.TRUST_PROXY,
};

module.exports = { config };
