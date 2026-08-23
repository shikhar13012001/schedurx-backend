// Thin wrapper around the official `stripe` SDK — kept separate from
// invoice-service.js (pure DB access) so the Stripe-specific shapes (paise
// conversion, Checkout Session params, webhook signature verification) live
// in one place.

function createCheckoutSession(stripeClient, { invoice, successUrl, cancelUrl }) {
  return stripeClient.checkout.sessions.create({
    mode: "payment",
    line_items: [
      {
        price_data: {
          currency: "inr",
          product_data: { name: `ScheduRx invoice ${invoice.id}` },
          unit_amount: Math.round(invoice.amountInr * 100), // Stripe amounts are in the smallest currency unit (paise)
        },
        quantity: 1,
      },
    ],
    metadata: { invoiceId: invoice.id, clinicId: invoice.clinicId },
    success_url: successUrl,
    cancel_url: cancelUrl,
  });
}

// Phase 3 (pay-first token payments) — same mode:"payment" one-off shape as
// createCheckoutSession above, deliberately not reusing that function
// directly since its metadata/product-name are Invoice-specific. Token
// amounts are per-clinic (Clinic.tokenAmountPaise) and dynamic, so this
// needs no Stripe Price id — same reasoning as the invoice flow.
function createTokenCheckoutSession(stripeClient, { pendingBookingId, amountPaise, clinicId, clinicName, successUrl, cancelUrl }) {
  return stripeClient.checkout.sessions.create({
    mode: "payment",
    line_items: [
      {
        price_data: {
          currency: "inr",
          product_data: { name: `${clinicName ?? "ScheduRx"} — booking token payment` },
          unit_amount: amountPaise,
        },
        quantity: 1,
      },
    ],
    metadata: { pendingBookingId, clinicId },
    success_url: successUrl,
    cancel_url: cancelUrl,
  });
}

// rawBody must be the untouched request body Buffer — see routes/stripe-webhook.js
// for why it's mounted before express.json().
function constructEvent(stripeClient, rawBody, signature, webhookSecret) {
  return stripeClient.webhooks.constructEvent(rawBody, signature, webhookSecret);
}

module.exports = { createCheckoutSession, createTokenCheckoutSession, constructEvent };
