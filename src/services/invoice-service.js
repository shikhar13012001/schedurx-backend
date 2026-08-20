const { makeId } = require("../lib/ids");

function dbErr(msg) {
  return Object.assign(new Error(`DB error ${msg}`), { code: "DATABASE_ERROR", statusCode: 500 });
}

async function listInvoices(supabaseClient, clinicId, { status } = {}) {
  let query = supabaseClient.from("Invoice").select("*").eq("clinicId", clinicId);
  if (status) query = query.eq("status", status);

  const { data, error } = await query.order("createdAt", { ascending: false });
  if (error) throw dbErr(`listing invoices: ${error.message}`);
  return data ?? [];
}

async function createInvoice(supabaseClient, { clinicId, patientId, appointmentId, visitId, amountInr, provider }) {
  if (!amountInr || amountInr <= 0) {
    throw Object.assign(new Error("amountInr must be a positive number"), { code: "INVALID_AMOUNT", statusCode: 422 });
  }

  const now = new Date().toISOString();
  const { data, error } = await supabaseClient
    .from("Invoice")
    .insert({
      id: makeId("inv"),
      clinicId,
      patientId: patientId ?? null,
      appointmentId: appointmentId ?? null,
      visitId: visitId ?? null,
      amountInr,
      status: "pending",
      // Explicit rather than relying on the column default, matching how
      // appointment-service.js never relies on Appointment.status's default either.
      provider: provider ?? "stripe",
      createdAt: now,
      updatedAt: now,
    })
    .select()
    .single();
  if (error) throw dbErr(`creating invoice: ${error.message}`);
  return data;
}

async function attachStripeSession(supabaseClient, invoiceId, stripeCheckoutSessionId) {
  const { error } = await supabaseClient
    .from("Invoice")
    .update({ stripeCheckoutSessionId, updatedAt: new Date().toISOString() })
    .eq("id", invoiceId);
  if (error) throw dbErr(`attaching Stripe session: ${error.message}`);
}

// providerReference is the canonical "identify this payment" field regardless
// of gateway (see docs/live-schema-baseline.md) — for Stripe it's the
// payment_intent id. providerMetadata keeps a small record of what triggered
// the update, for support/reconciliation, without requiring the caller to
// pass the full webhook event object.
async function markPaidByStripeSession(supabaseClient, stripeCheckoutSessionId, stripePaymentIntentId) {
  const now = new Date().toISOString();
  const { data, error } = await supabaseClient
    .from("Invoice")
    .update({
      status: "paid",
      providerReference: stripePaymentIntentId,
      providerMetadata: { stripeCheckoutSessionId, stripePaymentIntentId, markedPaidAt: now },
      paidAt: now,
      updatedAt: now,
    })
    .eq("stripeCheckoutSessionId", stripeCheckoutSessionId)
    .select()
    .maybeSingle();
  if (error) throw dbErr(`marking invoice paid: ${error.message}`);
  return data ?? null; // null is expected if the session wasn't ours (defensive, never throws in a webhook path)
}

module.exports = { listInvoices, createInvoice, attachStripeSession, markPaidByStripeSession };
