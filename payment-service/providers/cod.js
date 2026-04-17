/**
 * Cash-on-delivery (COD) payment provider.
 *
 * No-op provider — COD orders have no card authorization. All methods
 * return success immediately. The intentId is a synthetic ID so the
 * rest of the escrow logic can treat COD orders uniformly.
 */

/**
 * COD "authorize" — no card to charge, just return a synthetic intent.
 */
async function authorize({ amountCents, currency, orderId }) {
    return {
        intentId:     `cod-${orderId}`,
        clientSecret: null,
        status:       'authorized',
        provider:     'cod',
    };
}

/**
 * COD "capture" — funds are collected on delivery, nothing to do here.
 */
async function capture({ intentId }) {
    return {
        chargeId: intentId,
        status:   'succeeded',
    };
}

/**
 * COD "cancel" — nothing to void.
 */
async function cancel({ intentId }) {
    return { status: 'canceled' };
}

/**
 * COD "refund" — cash refunds are handled offline; record the intent only.
 */
async function refund({ chargeId, amountCents, reason }) {
    return {
        refundId: `cod-refund-${chargeId}-${Date.now()}`,
        status:   'succeeded',
    };
}

/**
 * COD "collect" — seller physically collected cash; record the event.
 * No card charge to make — the escrow release is handled by the caller.
 */
async function collect({ orderId }) {
    return {
        status:      'collected',
        collectedAt: new Date().toISOString(),
        orderId,
    };
}

/**
 * COD has no webhooks — this should never be called in practice.
 */
function constructWebhookEvent(rawBody, signature, secret) {
    throw new Error('COD provider does not support webhooks');
}

module.exports = { authorize, capture, cancel, refund, collect, constructWebhookEvent };
