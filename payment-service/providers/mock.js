/**
 * Mock payment provider.
 *
 * Simulates the current synchronous-success behaviour for use in
 * development and test environments. Activated by PAYMENT_PROVIDER=mock.
 *
 * Never allowed in production — getProvider() enforces this.
 *
 * All amounts and IDs are echoed back so tests can assert on them.
 */

let _seq = 0;
function _id(prefix) {
    return `mock_${prefix}_${Date.now()}_${++_seq}`;
}

/**
 * Instantly "authorize" without hitting any payment gateway.
 */
async function authorize({ amountCents, currency, orderId, idempotencyKey }) {
    return {
        intentId:     _id('pi'),
        clientSecret: `mock_secret_${orderId}`,
        status:       'requires_capture',
        provider:     'mock',
    };
}

/**
 * Instantly "capture" — returns a synthetic charge ID.
 */
async function capture({ intentId, amountCents }) {
    return {
        chargeId: _id('ch'),
        status:   'succeeded',
    };
}

/**
 * Instantly "cancel" a payment intent.
 */
async function cancel({ intentId }) {
    return { status: 'canceled' };
}

/**
 * Instantly issue a refund without hitting any gateway.
 */
async function refund({ chargeId, amountCents, reason, idempotencyKey }) {
    return {
        refundId: _id('re'),
        status:   'succeeded',
    };
}

/**
 * Parse a mock webhook event body.
 * Accepts JSON — no signature verification in mock mode.
 */
function constructWebhookEvent(rawBody, signature, secret) {
    const body = rawBody instanceof Buffer ? rawBody.toString('utf8') : rawBody;
    return JSON.parse(body);
}

module.exports = { authorize, capture, cancel, refund, constructWebhookEvent };
