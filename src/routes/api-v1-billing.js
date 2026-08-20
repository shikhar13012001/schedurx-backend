// Invoice listing works without Stripe (it's just reading Postgres); only
// checkout-session creation actually needs the Stripe client, so that one
// route fails gracefully (503) inline rather than the whole router being
// conditionally mounted — same "single action, not a whole subsystem" shape
// used for WhatsApp/push, since invoices are useful before Stripe exists.

const { Router } = require("express");
const { ok, fail } = require("../lib/response-envelope");
const invoiceSvc = require("../services/invoice-service");
const stripeSvc = require("../services/stripe-service");

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

  return router;
}

module.exports = { createApiV1BillingRouter };
