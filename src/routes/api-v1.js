// Dashboard REST API. Mounted at /api/v1 in app.js, only when firebaseAdminApp
// is configured. Every route below runs behind firebaseAuth, so req.staff is
// always present — clinicId for every query comes from req.staff.clinicId,
// never from the request itself.

const { Router } = require("express");
const { firebaseAuth } = require("../middleware/firebase-auth");
const { ok } = require("../lib/response-envelope");

const { createApiV1AppointmentsRouter } = require("./api-v1-appointments");
const { createApiV1ClinicRouter } = require("./api-v1-clinic");
const { createApiV1PatientsRouter } = require("./api-v1-patients");
const { createApiV1TeamRouter } = require("./api-v1-team");
const { createApiV1DoctorsRouter } = require("./api-v1-doctors");
const { createApiV1QueueRouter } = require("./api-v1-queue");
const { createApiV1RealtimeTokenRouter } = require("./api-v1-realtime-token");
const { createApiV1VisitsRouter } = require("./api-v1-visits");
const { createApiV1ClinicSettingsRouter } = require("./api-v1-clinic-settings");
const { createApiV1ThreadsRouter } = require("./api-v1-threads");
const { createApiV1NotificationsRouter } = require("./api-v1-notifications");
const { createApiV1TasksRouter } = require("./api-v1-tasks");
const { createApiV1PhoneRoutesRouter } = require("./api-v1-phone-routes");
const { createApiV1PushSubscriptionsRouter } = require("./api-v1-push-subscriptions");
const { createApiV1AnalyticsRouter } = require("./api-v1-analytics");
const { createApiV1BillingRouter } = require("./api-v1-billing");
const { createApiV1AiRouter } = require("./api-v1-ai");
const { createApiV1AssistantRouter } = require("./api-v1-assistant");
const { createApiV1CallLogsRouter } = require("./api-v1-call-logs");
const { createApiV1WaLogsRouter } = require("./api-v1-wa-logs");
const { createApiV1MediaRouter } = require("./api-v1-media");
const { createApiV1OnboardingRouter } = require("./api-v1-onboarding");
const { createApiV1MessagingRouter } = require("./api-v1-messaging");

function createApiV1Router({
  supabaseClient,
  nettuClient,
  firebaseAdminApp,
  stripeClient,
  openaiClient,
  assistantModel,
  twilioClient,
  elevenLabsClient,
}) {
  const router = Router();

  router.use(firebaseAuth(firebaseAdminApp, supabaseClient));

  router.get("/me", (req, res) => ok(res, { staff: req.staff }));

  router.use("/appointments", createApiV1AppointmentsRouter(supabaseClient, nettuClient, twilioClient, stripeClient));
  router.use("/clinic", createApiV1ClinicRouter(supabaseClient));
  router.use("/patients", createApiV1PatientsRouter(supabaseClient));
  router.use("/team", createApiV1TeamRouter(supabaseClient, twilioClient));
  router.use("/doctors", createApiV1DoctorsRouter(supabaseClient));
  router.use("/queue", createApiV1QueueRouter(supabaseClient, twilioClient));
  router.use("/realtime-token", createApiV1RealtimeTokenRouter());
  router.use("/visits", createApiV1VisitsRouter(supabaseClient, openaiClient));
  router.use("/media", createApiV1MediaRouter(openaiClient));
  router.use("/clinic-settings", createApiV1ClinicSettingsRouter(supabaseClient));
  router.use("/threads", createApiV1ThreadsRouter(supabaseClient, twilioClient));
  router.use("/notifications", createApiV1NotificationsRouter(supabaseClient));
  router.use("/tasks", createApiV1TasksRouter(supabaseClient, nettuClient));
  router.use("/phone-routes", createApiV1PhoneRoutesRouter(supabaseClient));
  router.use("/push-subscriptions", createApiV1PushSubscriptionsRouter(supabaseClient));
  router.use("/analytics", createApiV1AnalyticsRouter(supabaseClient, openaiClient));
  router.use("/call-logs", createApiV1CallLogsRouter(supabaseClient));
  router.use("/wa-logs", createApiV1WaLogsRouter(supabaseClient));
  router.use("/onboarding", createApiV1OnboardingRouter(supabaseClient));
  router.use("/messaging", createApiV1MessagingRouter(supabaseClient));

  // Sub-gated: invoice listing works without Stripe, only checkout-session
  // creation needs it (checked inline in api-v1-billing.js).
  router.use("/billing", createApiV1BillingRouter(supabaseClient, stripeClient));

  // Whole-subsystem gate, matching nettuClient/firebaseAdminApp precedent.
  if (openaiClient) {
    router.use("/ai", createApiV1AiRouter(openaiClient));
  }

  // Separate gate from openaiClient above — this uses the AI SDK's model
  // wrapper (@ai-sdk/openai), not the raw `openai` client, so tests can
  // inject a mock LanguageModel the same way other subsystems inject stubs.
  if (assistantModel) {
    router.use("/assistant", createApiV1AssistantRouter({ supabaseClient, nettuClient, twilioClient, model: assistantModel, elevenLabsClient }));
  }

  return router;
}

module.exports = { createApiV1Router };
