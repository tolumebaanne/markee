/**
 * Payment provider factory.
 *
 * Reads PAYMENT_PROVIDER env var (default: 'stripe') and returns the
 * matching provider module. Uses lazy require so STRIPE_SECRET_KEY is
 * only touched when the Stripe provider is actually loaded — mock/COD
 * environments do not need Stripe credentials.
 *
 * Provider contract (duck-typed interface — every module must export):
 *
 *   authorize({ amountCents, currency, paymentMethodToken, orderId, idempotencyKey })
 *     → { intentId, status, provider }
 *
 *   capture({ intentId, amountCents })
 *     → { chargeId, status }
 *
 *   cancel({ intentId })
 *     → { status }
 *
 *   refund({ chargeId, amountCents, reason, idempotencyKey })
 *     → { refundId, status }
 *
 *   constructWebhookEvent(rawBody, signature, secret)
 *     → normalized event { type, data } or throws on bad signature
 */

const providerModules = {
    stripe: () => require('./stripe'),
    cod:    () => require('./cod'),
    mock:   () => require('./mock'),
};

module.exports = function getProvider(name) {
    const key = (name || process.env.PAYMENT_PROVIDER || 'stripe').toLowerCase();
    if (process.env.NODE_ENV === 'production' && key === 'mock') {
        throw new Error('PAYMENT_PROVIDER=mock is not allowed in production');
    }
    if (!providerModules[key]) throw new Error(`Unknown payment provider: ${key}`);
    return providerModules[key]();  // lazy — only loads the module when needed
};
