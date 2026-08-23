// Invoice listing works without Stripe (it's just reading Postgres); only
// checkout-session creation actually needs the Stripe client, so that one
// route fails gracefully (503) inline rather than the whole router being
// conditionally mounted — same "single action, not a whole subsystem" shape
// used for WhatsApp/push, since invoices are useful before Stripe exists.

const { Router } = require("express");
const { ok, fail } = require("../lib/response-envelope");
const invoiceSvc = require("../services/invoice-service");
const stripeSvc = require("../services/stripe-service");
const stripeSubSvc = require("../services/stripe-subscription-service");
const clinicSvc = require("../services/clinic-service");
const plansSvc = require("../lib/plans");
const { requireRole } = require("../middleware/require-role");
const { config } = require("../config");

function createApiV1BillingRouter(supabaseClient, stripeClient) {
  const router = Router();

  router.get("/invoices", async (req, res) => {
    try {
      const invoices = await invoiceSvc.listInvoices(supabaseClient, req.staff.clinicId, { status: req.query.status });
      return ok(res, { invoices });
    } catch (err) {
      req.log?.error({ err }, "[api-v1:billing] list invoices failed");
      return fail(res, err.statusCode ?? 500, err.code ?? "INTERNAL_ERROR", err.message);
    }
  });

  router.post("/invoices", async (req, res) => {
    try {
      const invoice = await invoiceSvc.createInvoice(supabaseClient, { ...req.body, clinicId: req.staff.clinicId });
      return res.status(201).json({ success: true, data: { invoice }, message: null });
    } catch (err) {
      req.log?.error({ err }, "[api-v1:billing] create invoice failed");
      return fail(res, err.statusCode ?? 500, err.code ?? "INTERNAL_ERROR", err.message);
    }
  });

  router.post("/checkout-session", async (req, res) => {
    if (!stripeClient) {
      return fail(res, 503, "STRIPE_NOT_CONFIGURED", "STRIPE_SECRET_KEY is not set");
    }

    const { invoiceId, successUrl, cancelUrl } = req.body ?? {};
    if (!invoiceId || !successUrl || !cancelUrl) {
      return fail(res, 422, "MISSING_FIELDS", "invoiceId, successUrl, and cancelUrl are required");
    }

    try {
      const invoices = await invoiceSvc.listInvoices(supabaseClient, req.staff.clinicId);
      const invoice = invoices.find((i) => i.id === invoiceId);
      if (!invoice) return fail(res, 404, "INVOICE_NOT_FOUND", `Invoice '${invoiceId}' not found`);

      const session = await stripeSvc.createCheckoutSession(stripeClient, { invoice, successUrl, cancelUrl });
      await invoiceSvc.attachStripeSession(supabaseClient, invoiceId, session.id);

      return ok(res, { checkoutUrl: session.url, sessionId: session.id });
    } catch (err) {
      req.log?.error({ err }, "[api-v1:billing] checkout session failed");
      return fail(res, err.statusCode ?? 502, err.code ?? "STRIPE_ERROR", err.message);
    }
  });

  // ── Recurring subscription billing (Phase 2) — owner-only, same as every
  // other billing/plan-affecting route in this codebase.

  router.get("/subscription", requireRole("owner"), async (req, res) => {
    try {
      const clinic = await clinicSvc.requireActiveClinic(supabaseClient, req.staff.clinicId);
      return ok(res, stripeSubSvc.subscriptionSummary(clinic));
    } catch (err) {
      req.log?.error({ err }, "[api-v1:billing] get subscription failed");
      return fail(res, err.statusCode ?? 500, err.code ?? "INTERNAL_ERROR", err.message);
    }
  });

  router.post("/subscription/checkout-session", requireRole("owner"), async (req, res) => {
    if (!stripeClient) {
      return fail(res, 503, "STRIPE_NOT_CONFIGURED", "STRIPE_SECRET_KEY is not set");
    }
    const { planId, addonIds, successUrl, cancelUrl } = req.body ?? {};
    if (!planId || !successUrl || !cancelUrl) {
      return fail(res, 422, "MISSING_FIELDS", "planId, successUrl, and cancelUrl are required");
    }
    try {
      plansSvc.validatePlanSelection({ planId, addonIds: addonIds ?? [] });
      const missing = plansSvc.missingStripePriceIds(planId, addonIds ?? []);
      if (missing.length) {
        return fail(
          res,
          503,
          "STRIPE_PRICE_NOT_CONFIGURED",
          `No Stripe Price configured yet for: ${missing.join(", ")}`,
        );
      }

      const clinic = await clinicSvc.requireActiveClinic(supabaseClient, req.staff.clinicId);
      const customerId = await stripeSubSvc.getOrCreateCustomer(stripeClient, supabaseClient, clinic);
      const session = await stripeSubSvc.createSubscriptionCheckoutSession(stripeClient, {
        customerId,
        clinicId: clinic.id,
        planId,
        addonIds: addonIds ?? [],
        successUrl,
        cancelUrl,
      });
      return ok(res, { checkoutUrl: session.url, sessionId: session.id });
    } catch (err) {
      req.log?.error({ err }, "[api-v1:billing] subscription checkout session failed");
      return fail(res, err.statusCode ?? 502, err.code ?? "STRIPE_ERROR", err.message);
    }
  });

  router.post("/subscription/portal-session", requireRole("owner"), async (req, res) => {
    if (!stripeClient) {
      return fail(res, 503, "STRIPE_NOT_CONFIGURED", "STRIPE_SECRET_KEY is not set");
    }
    const { returnUrl } = req.body ?? {};
    if (!returnUrl) {
      return fail(res, 422, "MISSING_FIELDS", "returnUrl is required");
    }
    try {
      const clinic = await clinicSvc.requireActiveClinic(supabaseClient, req.staff.clinicId);
      if (!clinic.stripeCustomerId) {
        return fail(res, 409, "NO_SUBSCRIPTION", "This clinic has no billing account yet — subscribe to a plan first");
      }
      const session = await stripeSubSvc.createPortalSession(stripeClient, {
        customerId: clinic.stripeCustomerId,
        returnUrl,
        configurationId: config.STRIPE_PORTAL_CONFIGURATION_ID,
      });
      return ok(res, { url: session.url });
    } catch (err) {
      req.log?.error({ err }, "[api-v1:billing] portal session failed");
      return fail(res, err.statusCode ?? 502, err.code ?? "STRIPE_ERROR", err.message);
    }
  });

  // Addon add/remove for the 'custom' plan — Stripe's Customer Portal can't
  // express independent per-item toggling on a multi-item subscription (see
  // stripe-subscription-service.js's file header), so this is this
  // codebase's own small API for that, sitting alongside Portal rather than
  // replacing it.
  router.post("/subscription/addons", requireRole("owner"), async (req, res) => {
    if (!stripeClient) {
      return fail(res, 503, "STRIPE_NOT_CONFIGURED", "STRIPE_SECRET_KEY is not set");
    }
    const { addonId, action } = req.body ?? {};
    if (!addonId || !["add", "remove"].includes(action)) {
      return fail(res, 422, "MISSING_FIELDS", "addonId and action ('add'|'remove') are required");
    }
    try {
      const clinic = await clinicSvc.requireActiveClinic(supabaseClient, req.staff.clinicId);
      if (clinic.plan?.planId !== "custom") {
        return fail(res, 422, "INVALID_ADDON", "Add-ons only apply to the 'custom' plan");
      }

      const subscriptionItems =
        action === "add"
          ? await stripeSubSvc.addAddonItem(stripeClient, supabaseClient, clinic, addonId)
          : await stripeSubSvc.removeAddonItem(stripeClient, supabaseClient, clinic, addonId);

      const addonIds = Object.keys(subscriptionItems.addons ?? {});
      const updatedPlan = await clinicSvc.updateClinicPlan(supabaseClient, clinic.id, {
        planId: "custom",
        addonIds,
      });
      return ok(res, { plan: updatedPlan, addons: addonIds });
    } catch (err) {
      req.log?.error({ err }, "[api-v1:billing] subscription addon update failed");
      return fail(res, err.statusCode ?? 502, err.code ?? "STRIPE_ERROR", err.message);
    }
  });

  return router;
}

module.exports = { createApiV1BillingRouter };
