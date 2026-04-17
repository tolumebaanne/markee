/**
 * Stripe payment provider.
 *
 * Implements the provider contract using the `stripe` npm package.
 * Uses authorize-then-capture model (capture_method: 'manual') for escrow.
 *
 * Required env vars:
 *   STRIPE_SECRET_KEY        — Stripe secret key (sk_live_... or sk_test_...)
 *   STRIPE_WEBHOOK_SECRET    — Webhook endpoint signing secret (whsec_...)
 *   STRIPE_API_VERSION       — Optional, defaults to '2023-10-16'
 */

const Stripe = require('stripe');

// Initialized once at module load — lazy require means this only runs
// when getProvider('stripe') is first called, not at payment-service startup
const stripe = Stripe(process.env.STRIPE_SECRET_KEY, {
    apiVersion: process.env.STRIPE_API_VERSION || '2023-10-16',
});

/**
 * Create a PaymentIntent with capture_method: 'manual'.
 * This authorizes the card without capturing funds.
 */
async function authorize({ amountCents, currency, orderId, idempotencyKey }) {
    const intent = await stripe.paymentIntents.create(
        {
            amount:         amountCents,
            currency:       currency || 'cad',
            capture_method: 'manual',
            metadata:       { orderId: orderId?.toString() || '' },
        },
        idempotencyKey ? { idempotencyKey: `auth-${idempotencyKey}` } : {}
    );
    return {
        intentId:  intent.id,
        clientSecret: intent.client_secret,
        status:    intent.status,
        provider:  'stripe',
    };
}

/**
 * Capture a previously authorized PaymentIntent.
 * Called by releaseEscrow() when the dispute window expires or buyer confirms.
 */
async function capture({ intentId, amountCents }) {
    const intent = await stripe.paymentIntents.capture(intentId, {
        amount_to_capture: amountCents,
    });
    const chargeId = intent.latest_charge;
    return {
        chargeId: chargeId || null,
        status:   intent.status,
    };
}

/**
 * Cancel an authorized PaymentIntent without capturing.
 * Called when an order is cancelled before the dispute window closes.
 */
async function cancel({ intentId }) {
    const intent = await stripe.paymentIntents.cancel(intentId);
    return { status: intent.status };
}

/**
 * Issue a full or partial refund on a captured charge.
 * amountCents is optional — omit to refund the full charge amount.
 */
async function refund({ chargeId, amountCents, reason, idempotencyKey }) {
    const params = {
        charge:   chargeId,
        metadata: { reason: reason || '' },
    };
    if (amountCents) params.amount = amountCents;

    const refundObj = await stripe.refunds.create(
        params,
        idempotencyKey ? { idempotencyKey: `refund-${idempotencyKey}` } : {}
    );
    return {
        refundId: refundObj.id,
        status:   refundObj.status,
    };
}

/**
 * Verify a Stripe webhook event signature and return the parsed event.
 * rawBody must be a Buffer (not parsed JSON).
 */
function constructWebhookEvent(rawBody, signature, secret) {
    return stripe.webhooks.constructEvent(rawBody, signature, secret);
}

// S21 — expose raw stripe instance for customers / paymentMethods calls
module.exports = { authorize, capture, cancel, refund, constructWebhookEvent, stripe };
