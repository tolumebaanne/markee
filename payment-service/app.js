require('dotenv').config({ path: require('path').join(__dirname, '.env') });
const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const parseUser = require('../shared/middleware/parseUser');
const platformGuard = require('../shared/middleware/platformGuard');
const errorResponse = require('../shared/utils/errorResponse');
const bus = require('../shared/eventBus');
const getProvider = require('./providers');

// Capture Stripe credentials at module load time, before any other service's
// .env can override process.env (monolith loads envs sequentially).
const STRIPE_SECRET_KEY_AT_LOAD     = process.env.STRIPE_SECRET_KEY;
const STRIPE_WEBHOOK_SECRET_AT_LOAD = process.env.STRIPE_WEBHOOK_SECRET;

const app = express();

// ── Stripe webhook — must be BEFORE express.json() to preserve raw body ───────
// Handler body is assigned after model definitions; by request time the module
// is fully loaded and _stripeWebhookHandler points to the real async function.
//
// express.raw({ type: '*/*' }) accepts any Content-Type — necessary because:
//   1. nginx or http-proxy-middleware may append '; charset=utf-8' to the
//      Content-Type, causing express.raw({ type: 'application/json' }) to
//      skip buffering and leave req.body as undefined.
//   2. Stripe's signature is computed over the raw bytes of the original
//      payload; the body MUST arrive as a Buffer, never as parsed JSON.
let _stripeWebhookHandler = null;
app.post('/webhook/stripe', express.raw({ type: '*/*' }), (req, res) => {
    if (!_stripeWebhookHandler) return res.status(503).json({ error: 'Webhook not initialized' });
    if (!Buffer.isBuffer(req.body) || req.body.length === 0) {
        console.error('[PAYMENT] Webhook body not buffered — received:', typeof req.body, req.body);
        return res.status(400).send('Webhook Error: body was not buffered as raw bytes');
    }
    return _stripeWebhookHandler(req, res);
});

app.use(express.json());
app.use(cors());
app.use(parseUser);
app.use(platformGuard);

const db = mongoose.createConnection(process.env.MONGODB_URI);
db.on('connected', () => console.log('Payment DB Connected'));
db.on('error', (err) => console.error('[PAYMENT] DB error:', err.message));

// ── S1 — Schemas ──────────────────────────────────────────────────────────────

const SellerPayoutSchema = new mongoose.Schema({
    sellerId:         { type: mongoose.Schema.Types.ObjectId, required: true },
    amountCents:      { type: Number, required: true },       // gross payout (before fee)
    platformFeeCents: { type: Number, default: 0 },           // fee retained by platform
    netAmountCents:   { type: Number, required: true },       // amountCents - platformFeeCents
    released:         { type: Boolean, default: false }
}, { _id: false });

// EventLog is append-only. No update, no delete.
// Append-only compliance: audit requirement — each financial state change must
// produce an immutable record. Future developers: do NOT call updateOne/findByIdAndUpdate on this model.
const EventLogSchema = new mongoose.Schema({
    orderId:   { type: mongoose.Schema.Types.ObjectId, required: true, index: true },
    event:     { type: String, required: true },
    actorId:   mongoose.Schema.Types.ObjectId,
    actorRole: String,
    metadata:  mongoose.Schema.Types.Mixed,
    timestamp: { type: Date, default: Date.now }
}, { timestamps: false });

// Enforce append-only at the ODM layer — throws on any update attempt
EventLogSchema.pre('findOneAndUpdate', function() {
    throw new Error('EventLog is append-only — updates are prohibited (audit compliance)');
});
EventLogSchema.pre('updateOne', function() {
    throw new Error('EventLog is append-only — updates are prohibited (audit compliance)');
});
EventLogSchema.pre('updateMany', function() {
    throw new Error('EventLog is append-only — updates are prohibited (audit compliance)');
});

const EscrowSchema = new mongoose.Schema({
    orderId:       { type: mongoose.Schema.Types.ObjectId, required: true, unique: true },
    buyerId:       { type: mongoose.Schema.Types.ObjectId, required: true },
    // amountCents: renamed from 'amount'. Dual-read migration shim for existing docs:
    //   const amountCents = esc.amountCents ?? esc.amount ?? 0;
    amountCents:   { type: Number, required: true },
    paymentMethod: { type: String, enum: ['stripe', 'cod', 'escrow'], default: 'stripe' },
    feePercent:    { type: Number, default: 0 },              // snapshot of PLATFORM_FEE_PERCENT at creation time
    status: {
        type:    String,
        enum:    ['held', 'released', 'refunded', 'disputed', 'cod_pending', 'split_resolved', 'authorizing'],
        default: 'held'
    },
    // Stripe fields (Phase 3)
    stripePaymentIntentId: { type: String, default: null },
    stripeChargeId:        { type: String, default: null },
    stripeRefundId:        { type: String, default: null },
    provider:              { type: String, enum: ['stripe', 'cod', 'mock'], default: 'stripe' },
    currency:              { type: String, default: 'cad' },
    // Tax and coupon line items
    taxCents:              { type: Number, default: 0 },
    taxBreakdown:          {
        gst: { type: Number, default: 0 },
        pst: { type: Number, default: 0 },
        qst: { type: Number, default: 0 },
        hst: { type: Number, default: 0 },
    },
    deliveryCents:         { type: Number, default: 0 },
    discountCents:         { type: Number, default: 0 },
    couponCode:            { type: String, default: null },
    split_resolved:        { type: Boolean, default: false },   // true once a split-refund admin action has been completed
    // Freeze (admin hold — prevents auto-release and manual release)
    frozen:                { type: Boolean, default: false },
    frozenReason:          { type: String, default: '' },
    frozenAt:              { type: Date, default: null },
    frozenBy:              { type: String, default: null },   // admin userId
    sellerPayouts:          [SellerPayoutSchema],
    disputeWindowExpiresAt: Date,   // set when delivery event fires; null for COD
    disputeHeld:            { type: Boolean, default: false },
    releasedAt:             Date,
    codCollectedAt:         Date,
    refundReason:           String,
    createdAt:              { type: Date, default: Date.now }
});

EscrowSchema.index({ buyerId: 1 });
EscrowSchema.index({ 'sellerPayouts.sellerId': 1 });
EscrowSchema.index({ status: 1, disputeWindowExpiresAt: 1 });   // dispute window sweep query
EscrowSchema.index({ status: 1, createdAt: -1 });               // cod_pending expiry sweep

const Escrow   = db.model('Escrow', EscrowSchema);
const EventLog = db.model('EventLog', EventLogSchema);

// ── S15 — PlatformConfig (shared helper) ─────────────────────────────────────
const { getPlatformConfig, invalidatePlatformConfigCache } = require('../shared/utils/platformConfig');

// Seed on startup — non-blocking; errors are logged and do not crash the service
getPlatformConfig().catch(err => console.error('[PAYMENT] PlatformConfig seed error:', err.message));

// ── S2 — Platform fee helpers ─────────────────────────────────────────────────

const PLATFORM_FEE_PERCENT = parseFloat(process.env.PLATFORM_FEE_PERCENT || '0');
const DISPUTE_WINDOW_HOURS = parseInt(process.env.DISPUTE_WINDOW_HOURS   || '48', 10);

function buildSellerPayouts(items, feePercent) {
    const payoutMap = {};
    for (const item of items) {
        const sid = item.sellerId?.toString();
        if (!sid) continue;
        payoutMap[sid] = (payoutMap[sid] || 0) + (item.qty * item.price);
    }
    let totalFee = 0;
    const payouts = Object.entries(payoutMap).map(([sellerId, gross]) => {
        const platformFeeCents = Math.floor(gross * feePercent / 100);
        const netAmountCents   = gross - platformFeeCents;
        totalFee += platformFeeCents;
        return { sellerId, amountCents: gross, platformFeeCents, netAmountCents };
    });
    return { payouts, totalFee };
}

async function logEvent(orderId, event, actorId, actorRole, metadata) {
    try {
        await EventLog.create({ orderId, event, actorId, actorRole, metadata });
    } catch (err) {
        console.error('[PAYMENT] EventLog write error:', err.message);
    }
}

// ── S7 — Dispute window helper (replaces immediate release for delivery events) ──

async function startDisputeWindow(esc) {
    const cfg = await getPlatformConfig();
    const windowHours = cfg.disputeWindowHours;
    const expiresAt = new Date(Date.now() + windowHours * 60 * 60 * 1000);
    esc.disputeWindowExpiresAt = expiresAt;
    await esc.save();
    await logEvent(esc.orderId, 'dispute_window_started', null, 'system', {
        expiresAt,
        windowHours
    });
    console.log(`[PAYMENT] Dispute window set for order ${esc.orderId}, expires ${expiresAt.toISOString()}`);
}

// ── S8 — Release helper (used by sweep and buyer_confirmed) ──────────────────

async function releaseEscrow(esc, trigger, actorId = null, actorRole = 'system') {
    // Guard: frozen escrows cannot be released until admin unfreezes them
    if (esc.frozen) {
        await logEvent(esc.orderId, 'release_blocked_frozen', null, 'system', { reason: esc.frozenReason, trigger });
        console.warn(`[PAYMENT] Release blocked — escrow for order ${esc.orderId} is frozen: ${esc.frozenReason}`);
        return;
    }

    const now = new Date();

    // Guard: check per-seller payout holds before releasing (1h)
    // Sellers under a payout hold are skipped; rest are released normally
    const heldSellerIds = new Set();
    for (const payout of esc.sellerPayouts) {
        const hold = await PayoutHold.findOne({ sellerId: payout.sellerId });
        if (hold) {
            heldSellerIds.add(payout.sellerId.toString());
            await logEvent(esc.orderId, 'payout_hold_blocked', null, 'system', {
                sellerId:   payout.sellerId,
                holdReason: hold.reason,
                trigger
            });
            console.warn(`[PAYMENT] Payout hold active for seller ${payout.sellerId} on order ${esc.orderId} — skipping that seller`);
        }
    }

    // Phase 3 — capture Stripe payment before releasing funds
    if (esc.provider === 'stripe' && esc.stripePaymentIntentId && !esc.stripeChargeId) {
        try {
            const provider    = getProvider('stripe');
            const captureResult = await provider.capture({ intentId: esc.stripePaymentIntentId, amountCents: esc.amountCents });
            esc.stripeChargeId  = captureResult.chargeId;
            await logEvent(esc.orderId, 'stripe_captured', null, 'system', {
                chargeId: captureResult.chargeId,
                trigger
            });
            console.log(`[PAYMENT] Stripe captured charge ${captureResult.chargeId} for order ${esc.orderId}`);
        } catch (captureErr) {
            console.error(`[PAYMENT] Stripe capture failed for order ${esc.orderId}:`, captureErr.message);
            await logEvent(esc.orderId, 'stripe_capture_failed', null, 'system', {
                error: captureErr.message,
                trigger
            });
            return;  // Do not release — Stripe capture failed; admin must reconcile
        }
    }

    esc.sellerPayouts.forEach(p => {
        if (!heldSellerIds.has(p.sellerId?.toString())) {
            p.released = true;
        }
    });

    // Only transition to 'released' when no seller is blocked; otherwise partial release is noted in the log
    if (heldSellerIds.size === 0) {
        esc.status     = 'released';
        esc.releasedAt = now;
    }
    await esc.save();

    const releasedSellerIds = esc.sellerPayouts
        .filter(p => p.released)
        .map(p => p.sellerId?.toString())
        .filter(Boolean);

    await logEvent(esc.orderId, trigger, actorId, actorRole, {
        releasedAt:       heldSellerIds.size === 0 ? now : null,
        sellerIds:        releasedSellerIds,
        heldSellerIds:    [...heldSellerIds],
        amountCents:      esc.amountCents ?? esc.amount ?? 0,
        partialRelease:   heldSellerIds.size > 0
    });

    // Correction I: emit payment.captured so seller-service / analytics can update stats
    bus.emit('payment.captured', {
        orderId:     esc.orderId.toString(),
        amountCents: esc.amountCents ?? esc.amount ?? 0,
        sellerIds:   releasedSellerIds,
    });
    bus.emit('payment.auto_released', {
        orderId:     esc.orderId,
        buyerId:     esc.buyerId,
        sellerIds:   releasedSellerIds,
        amountCents: esc.amountCents ?? esc.amount ?? 0,
        releasedAt:  heldSellerIds.size === 0 ? now : null
    });
    console.log(`[PAYMENT] Escrow released via ${trigger} for order ${esc.orderId}${heldSellerIds.size > 0 ? ` (${heldSellerIds.size} seller(s) on payout hold)` : ''}`);
}

// ── Event listeners ──────────────────────────────────────────────────────────

// S2/S4 — order.placed: branch on paymentMethod
bus.on('order.placed', async (payload) => {
    try {
        const cfg           = await getPlatformConfig().catch(() => ({ platformFeePercent: PLATFORM_FEE_PERCENT, defaultCurrency: 'cad' }));
        const feePercent    = cfg.platformFeePercent ?? PLATFORM_FEE_PERCENT;
        const paymentMethod = payload.paymentMethod || 'escrow';
        const { payouts, totalFee } = buildSellerPayouts(payload.items || [], feePercent);

        // S6 (C1) — COD buyer reputation gate (best-effort)
        if (paymentMethod === 'cod') {
            try {
                const sellerId = [...new Set((payload.items || []).map(i => i.sellerId?.toString()).filter(Boolean))][0];
                if (sellerId) {
                    const sellerServiceUrl = process.env.SELLER_SERVICE_URL || 'http://localhost:5007';
                    const reviewServiceUrl = process.env.REVIEW_SERVICE_URL || 'http://localhost:5012';
                    const storeRes = await fetch(`${sellerServiceUrl}/by-seller/${sellerId}`).catch(() => null);
                    if (storeRes?.ok) {
                        const store = await storeRes.json();
                        const minScore = store.minCodBuyerScore || 0;
                        if (minScore > 0) {
                            const scoreRes = await fetch(`${reviewServiceUrl}/seller/${payload.buyerId}/stats`).catch(() => null);
                            if (scoreRes?.ok) {
                                const stats = await scoreRes.json();
                                const buyerScore = stats.avgRating || 0;
                                if (buyerScore < minScore) {
                                    bus.emit('payment.cod_rejected', {
                                        orderId: payload.orderId,
                                        buyerId: payload.buyerId,
                                        reason:  'buyer_score_too_low',
                                        minScore,
                                        buyerScore
                                    });
                                    console.log(`[PAYMENT] COD rejected for order ${payload.orderId} — buyer score ${buyerScore} < min ${minScore}`);
                                    return;
                                }
                            }
                        }
                    }
                }
            } catch (err) {
                console.warn('[PAYMENT] COD reputation gate error (fail open):', err.message);
            }
        }

        const totalAmount  = payload.totalAmount;
        const isStripe     = paymentMethod !== 'cod' && !!payload.stripePaymentIntentId;
        const escrowStatus = paymentMethod === 'cod' ? 'cod_pending' : (isStripe ? 'authorizing' : 'held');

        const esc = await Escrow.create({
            orderId:               payload.orderId,
            buyerId:               payload.buyerId,
            amountCents:           totalAmount,
            paymentMethod,
            feePercent,
            status:                escrowStatus,
            sellerPayouts:         payouts,
            // Phase 7 — tax and coupon breakdown from order-service
            taxCents:              payload.taxCents      || 0,
            taxBreakdown:          payload.taxBreakdown  || { gst: 0, pst: 0, qst: 0, hst: 0 },
            deliveryCents:         payload.deliveryCents || 0,
            discountCents:         payload.discountCents || 0,
            couponCode:            payload.couponCode    || null,
            currency:              payload.currency      || cfg.defaultCurrency || 'cad',
            // Phase 3 — Stripe intent ID (present for card orders, null for COD)
            stripePaymentIntentId: payload.stripePaymentIntentId || null,
            provider:              paymentMethod === 'cod' ? 'cod' : 'stripe',
        });

        await logEvent(payload.orderId, 'escrow_created', payload.buyerId, 'buyer', {
            amountCents: totalAmount,
            paymentMethod,
            feePercent,
            totalPlatformFeeCents: totalFee
        });

        if (paymentMethod === 'cod') {
            bus.emit('payment.pending', {
                orderId:  esc.orderId,
                buyerId:  esc.buyerId,
                amountCents: esc.amountCents
            });
            console.log(`[PAYMENT] COD escrow (cod_pending) for order ${payload.orderId}, total: ${totalAmount}`);
        } else if (isStripe) {
            // Stripe path: escrow in 'authorizing' — Stripe webhook transitions to 'held' on authorization
            bus.emit('payment.authorizing', {
                orderId:     esc.orderId,
                buyerId:     esc.buyerId,
                amountCents: esc.amountCents,
                intentId:    payload.stripePaymentIntentId,
            });
            console.log(`[PAYMENT] Stripe escrow (authorizing) for order ${payload.orderId}, intent: ${payload.stripePaymentIntentId}`);
        } else {
            // Mock / other provider path — escrow held immediately
            console.log(`[PAYMENT] Escrow (${esc.status}) for order ${payload.orderId}, total: ${totalAmount}`);
        }
    } catch (err) { console.error('[PAYMENT] order.placed error:', err.message); }
});

// S7 — shipment.delivered: start dispute window instead of immediate release
bus.on('shipment.delivered', async (payload) => {
    try {
        const esc = await Escrow.findOne({ orderId: payload.orderId });
        if (!esc || esc.status !== 'held') return;
        await startDisputeWindow(esc);
    } catch (err) { console.error('[PAYMENT] shipment.delivered error:', err.message); }
});

// S7 — order.picked_up: start dispute window instead of immediate release
bus.on('order.picked_up', async (payload) => {
    try {
        const esc = await Escrow.findOne({ orderId: payload.orderId });
        if (!esc || esc.status !== 'held') return;
        await startDisputeWindow(esc);
    } catch (err) { console.error('[PAYMENT] order.picked_up error:', err.message); }
});

// S7 — order.self_fulfilled: start dispute window instead of immediate release
bus.on('order.self_fulfilled', async (payload) => {
    try {
        const esc = await Escrow.findOne({ orderId: payload.orderId });
        if (!esc || esc.status !== 'held') return;
        await startDisputeWindow(esc);
    } catch (err) { console.error('[PAYMENT] order.self_fulfilled error:', err.message); }
});

// shipment.buyer_confirmed: immediate release — buyer waived dispute right
bus.on('shipment.buyer_confirmed', async (payload) => {
    try {
        const esc = await Escrow.findOne({ orderId: payload.orderId });
        if (!esc || !['held', 'disputed'].includes(esc.status)) return;
        await releaseEscrow(esc, 'shipment.buyer_confirmed', payload.buyerId, 'buyer');
    } catch (err) { console.error('[PAYMENT] shipment.buyer_confirmed error:', err.message); }
});

// Shipping auto-cancellation: refund held escrow
bus.on('shipment.auto_cancelled', async (payload) => {
    try {
        const esc = await Escrow.findOne({ orderId: payload.orderId });
        if (!esc || esc.status !== 'held') return;
        esc.status       = 'refunded';
        esc.refundReason = payload.reason || 'shipment_auto_cancelled';
        await esc.save();
        await logEvent(esc.orderId, 'escrow_refunded', null, 'system', { reason: esc.refundReason });
        bus.emit('payment.refunded', {
            orderId:     esc.orderId,
            buyerId:     esc.buyerId,
            amountCents: esc.amountCents ?? esc.amount ?? 0,
            reason:      esc.refundReason
        });
        console.log(`[PAYMENT] Escrow refunded for auto-cancelled shipment on order ${payload.orderId}`);
    } catch (err) { console.error('[PAYMENT] shipment.auto_cancelled error:', err.message); }
});

// Buyer pickup no-show: refund held escrow
bus.on('shipment.pickup_noshow', async (payload) => {
    try {
        const esc = await Escrow.findOne({ orderId: payload.orderId });
        if (!esc || esc.status !== 'held') return;
        esc.status       = 'refunded';
        esc.refundReason = 'buyer_pickup_noshow';
        await esc.save();
        await logEvent(esc.orderId, 'escrow_refunded', null, 'system', { reason: 'buyer_pickup_noshow' });
        bus.emit('payment.refunded', {
            orderId:     esc.orderId,
            buyerId:     esc.buyerId,
            amountCents: esc.amountCents ?? esc.amount ?? 0,
            reason:      'buyer_pickup_noshow'
        });
        console.log(`[PAYMENT] Escrow refunded for buyer pickup no-show on order ${payload.orderId}`);
    } catch (err) { console.error('[PAYMENT] shipment.pickup_noshow error:', err.message); }
});

bus.on('order.inventory_failed', async (payload) => {
    try {
        const esc = await Escrow.findOne({ orderId: payload.orderId });
        if (!esc || esc.status !== 'held') return;
        esc.status      = 'refunded';
        esc.refundReason = 'inventory_failure';
        await esc.save();
        await logEvent(payload.orderId, 'escrow_refunded', null, 'system', { reason: 'inventory_failure' });
        console.log(`[PAYMENT] Escrow refunded for failed order ${payload.orderId}`);
    } catch (err) { console.error('[PAYMENT] order.inventory_failed error:', err.message); }
});

// order.cancelled: cancel or refund via provider, then mark escrow refunded (S9 — Phase 4c complete)
bus.on('order.cancelled', async ({ orderId, reason, buyerId }) => {
    try {
        const esc = await Escrow.findOne({ orderId });
        if (!esc || ['released', 'refunded'].includes(esc.status)) return;

        // Call Stripe to cancel or refund depending on capture state
        if (esc.provider === 'stripe') {
            const provider = getProvider('stripe');
            try {
                if (esc.stripeChargeId) {
                    // Captured — issue a refund
                    const refundResult = await provider.refund({
                        chargeId: esc.stripeChargeId,
                        reason:   'order_cancelled',
                        idempotencyKey: `cancel-${orderId}`,
                    });
                    esc.stripeRefundId = refundResult.refundId;
                } else if (esc.stripePaymentIntentId && ['authorizing', 'held'].includes(esc.status)) {
                    // Not yet captured — cancel intent only when status is authorizing or held
                    await provider.cancel({ intentId: esc.stripePaymentIntentId });
                }
            } catch (stripeErr) {
                console.error(`[PAYMENT] Stripe cancel/refund on order.cancelled failed for ${orderId}:`, stripeErr.message);
                // Continue — escrow is still marked refunded; admin can reconcile in Stripe dashboard
            }
        }

        esc.status       = 'refunded';
        esc.refundReason = reason || 'order_cancelled';
        await esc.save();
        await logEvent(esc.orderId, 'escrow_cancelled', null, 'system', { reason: esc.refundReason, buyerId });

        bus.emit('payment.cancelled', {
            orderId: esc.orderId.toString(),
            buyerId: (buyerId || esc.buyerId)?.toString(),
        });

        console.log(`[PAYMENT] order.cancelled processed for ${orderId} (reason: ${reason}, status was: ${esc.status})`);
    } catch (err) { console.error('[PAYMENT] order.cancelled error:', err.message); }
});

// S18 — payment.cod_collected: seller marked cash received → release escrow + emit payment.captured
bus.on('payment.cod_collected', async (payload) => {
    try {
        const esc = await Escrow.findOne({ orderId: payload.orderId });
        if (!esc) return console.error(`[PAYMENT] payment.cod_collected — no escrow for order ${payload.orderId}`);
        // Idempotency: already released = no-op
        if (esc.status === 'released') {
            console.log(`[PAYMENT] COD escrow for order ${payload.orderId} already released — skipping`);
            return;
        }
        const provider = getProvider('cod');
        await provider.collect({ orderId: payload.orderId });

        const now = new Date();
        esc.status         = 'released';
        esc.releasedAt     = now;
        esc.codCollectedAt = now;
        esc.sellerPayouts.forEach(p => { p.released = true; });
        await esc.save();

        await logEvent(esc.orderId, 'cod_collected', payload.sellerIds?.[0] || null, 'seller', {
            collectedAt: now,
            amountCents: esc.amountCents ?? esc.amount ?? 0,
        });

        bus.emit('payment.captured', {
            orderId:     esc.orderId.toString(),
            amountCents: esc.amountCents ?? esc.amount ?? 0,
            sellerIds:   esc.sellerPayouts.map(p => p.sellerId.toString()),
        });
        console.log(`[PAYMENT] COD escrow released for order ${payload.orderId}`);
    } catch (err) { console.error('[PAYMENT] payment.cod_collected error:', err.message); }
});

// Anonymize settled escrow buyerIds on hard-delete — financial records are preserved, PII scrubbed
bus.on('user.deleted', async (payload) => {
    try {
        const uid = payload.userId;
        const SENTINEL = new mongoose.Types.ObjectId('000000000000000000000000');
        const result = await Escrow.updateMany(
            { buyerId: uid, status: { $in: ['released', 'refunded', 'cod_pending'] } },
            { $set: { buyerId: SENTINEL } }
        );
        console.log(`[PAYMENT] Anonymized buyerId on ${result.modifiedCount} settled escrow(s) for user ${uid}`);
    } catch (err) { console.error('[PAYMENT] user.deleted anonymization error:', err.message); }
});

// S22 — Invalidate platformConfig cache when admin-service updates fee or dispute window
bus.on('platform.fee_updated',             () => invalidatePlatformConfigCache());
bus.on('platform.dispute_window_updated',  () => invalidatePlatformConfigCache());

// ── S8 — Dispute window sweep + COD expiry ────────────────────────────────────
// Two queries per run:
//   1. Auto-release: held escrowed orders past their dispute window with no active hold
//   2. COD expiry: cod_pending orders older than 7 days
// Fires immediately on startup (catches any windows that expired during downtime),
// then repeats every 30 minutes.

const SWEEP_INTERVAL_MS = 30 * 60 * 1000;

async function runSweep() {
    const now = new Date();
    const cfg = await getPlatformConfig().catch(() => ({ codExpiryDays: 7, sellerAcceptanceHours: 24 }));
    try {
        // Dispute window sweep — frozen escrows and payout-held sellers are handled inside releaseEscrow()
        const expired = await Escrow.find({
            status:                 'held',
            frozen:                 { $ne: true },
            disputeHeld:            false,
            disputeWindowExpiresAt: { $lte: now }
        });
        for (const esc of expired) {
            await releaseEscrow(esc, 'dispute_window_expired', null, 'system');
        }
        if (expired.length) console.log(`[PAYMENT] Sweep released ${expired.length} escrows`);

        // COD expiry sweep (C7)
        const codCutoff = new Date(now - (cfg.codExpiryDays || 7) * 24 * 60 * 60 * 1000);
        const expiredCod = await Escrow.find({
            status:    'cod_pending',
            createdAt: { $lt: codCutoff }
        });
        for (const esc of expiredCod) {
            const sellerIds = esc.sellerPayouts.map(p => p.sellerId?.toString()).filter(Boolean);
            esc.status = 'refunded';
            await esc.save();
            await logEvent(esc.orderId, 'cod_expired', null, 'system', { sellerIds });
            bus.emit('payment.cod_expired', {
                orderId:    esc.orderId,
                buyerId:    esc.buyerId,
                sellerIds,
                amountCents: esc.amountCents ?? esc.amount ?? 0
            });
            console.log(`[PAYMENT] COD expired for order ${esc.orderId}`);
        }
    } catch (err) { console.error('[PAYMENT] Sweep error:', err.message); }
}

// Run once immediately on startup — catches any windows that expired during downtime.
// Then schedule the recurring interval.
runSweep();
setInterval(runSweep, SWEEP_INTERVAL_MS);

// ── Phase 3 — Stripe webhook handler (body assigned here, route registered above express.json()) ──

_stripeWebhookHandler = async function handleStripeWebhook(req, res) {
    try {
        if (!STRIPE_SECRET_KEY_AT_LOAD) {
            return res.status(503).json({ error: 'Stripe not configured on this instance' });
        }
        const provider      = getProvider('stripe');
        const sig           = req.headers['stripe-signature'];
        const webhookSecret = STRIPE_WEBHOOK_SECRET_AT_LOAD;

        let event;
        try {
            event = provider.constructWebhookEvent(req.body, sig, webhookSecret);
        } catch (err) {
            console.error('[PAYMENT] Webhook signature failure:', err.message);
            return res.status(400).send(`Webhook Error: ${err.message}`);
        }

        // PaymentIntent authorized — transition escrow authorizing → held
        if (event.type === 'payment_intent.amount_capturable_updated') {
            const pi  = event.data.object;
            const esc = await Escrow.findOne({ stripePaymentIntentId: pi.id });
            if (esc && esc.status === 'authorizing') {
                esc.status = 'held';
                await esc.save();
                await logEvent(esc.orderId, 'payment_authorized', null, 'stripe_webhook', { intentId: pi.id });
                bus.emit('payment.authorized', {
                    orderId:     esc.orderId.toString(),
                    buyerId:     esc.buyerId.toString(),
                    sellerIds:   esc.sellerPayouts.map(p => p.sellerId.toString()),
                    amountCents: esc.amountCents ?? esc.amount ?? 0,
                    intentId:    pi.id,
                });
                console.log(`[PAYMENT] Stripe authorized for order ${esc.orderId}, intent ${pi.id}`);

                // S21 — Create / reuse Stripe Customer and attach the PaymentMethod
                // so the buyer can reuse saved cards on future orders.
                try {
                    const pmId = pi.payment_method;
                    if (pmId && process.env.STRIPE_SECRET_KEY) {
                        const stripeProvider = getProvider('stripe');
                        const userSvcUrl     = process.env.USER_SERVICE_URL || 'http://localhost:5013';
                        const userResp       = await fetch(`${userSvcUrl}/users/internal/${esc.buyerId}/stripe-data`, {
                            headers: { 'x-internal-service': 'payment-service' },
                        });
                        if (userResp.ok) {
                            const userData       = await userResp.json();
                            let stripeCustomerId = userData.stripeCustomerId || null;
                            if (!stripeCustomerId) {
                                const customer = await stripeProvider.stripe.customers.create({
                                    metadata: { userId: esc.buyerId.toString() },
                                    email:    userData.email       || undefined,
                                    name:     userData.displayName || undefined,
                                });
                                stripeCustomerId = customer.id;
                                bus.emit('user.stripe_customer_created', {
                                    userId:           esc.buyerId.toString(),
                                    stripeCustomerId: stripeCustomerId,
                                });
                            }
                            // Attach PM to Customer (idempotent — ignore "already attached")
                            try {
                                await stripeProvider.stripe.paymentMethods.attach(pmId, { customer: stripeCustomerId });
                            } catch (attachErr) {
                                if (!attachErr.message?.includes('already been attached')) {
                                    console.warn(`[PAYMENT] PM attach warning: ${attachErr.message}`);
                                }
                            }
                        }
                    }
                } catch (custErr) {
                    // Non-fatal — log and continue. Customer creation failure must not block order flow.
                    console.error('[PAYMENT] Stripe Customer creation error (non-fatal):', custErr.message);
                }
            }
        }
        // PaymentIntent failed — mark escrow refunded + cancel the order (correction D)
        else if (event.type === 'payment_intent.payment_failed') {
            const pi  = event.data.object;
            const esc = await Escrow.findOne({ stripePaymentIntentId: pi.id });
            if (esc && esc.status === 'authorizing') {
                esc.status       = 'refunded';
                esc.refundReason = 'stripe_auth_failed';
                await esc.save();
                await logEvent(esc.orderId, 'stripe_auth_failed', null, 'stripe_webhook', { intentId: pi.id });
                bus.emit('payment.failed', {
                    orderId:  esc.orderId.toString(),
                    buyerId:  esc.buyerId.toString(),
                    intentId: pi.id,
                });
                // Correction D: also emit order.cancelled so order-service cancels the order
                // and buyer is notified "card declined, no charge made"
                bus.emit('order.cancelled', {
                    orderId: esc.orderId.toString(),
                    reason:  'payment_failed',
                    buyerId: esc.buyerId.toString(),
                });
                console.log(`[PAYMENT] Stripe auth failed for order ${esc.orderId} — emitting order.cancelled`);
            }
        }
        // Charge refunded — store refundId + audit log
        else if (event.type === 'charge.refunded') {
            const charge   = event.data.object;
            const refundId = charge.refunds?.data?.[0]?.id || null;
            const esc      = await Escrow.findOne({ stripeChargeId: charge.id });
            if (esc) {
                if (refundId && !esc.stripeRefundId) {
                    esc.stripeRefundId = refundId;
                    await esc.save();
                }
                await logEvent(esc.orderId, 'stripe_charge_refunded', null, 'stripe_webhook', {
                    chargeId: charge.id,
                    refundId,
                });
            }
        }
        // Stripe-initiated dispute — freeze the escrow
        else if (event.type === 'charge.dispute.created') {
            const dispute = event.data.object;
            const esc     = await Escrow.findOne({ stripeChargeId: dispute.charge });
            if (esc && !esc.frozen) {
                esc.frozen       = true;
                esc.frozenReason = `Stripe dispute: ${dispute.reason || 'unknown'}`;
                esc.frozenAt     = new Date();
                esc.frozenBy     = 'stripe_webhook';
                await esc.save();
                await logEvent(esc.orderId, 'stripe_dispute_created', null, 'stripe_webhook', {
                    disputeId: dispute.id,
                    reason:    dispute.reason,
                    amount:    dispute.amount,
                });
                bus.emit('payment.disputed', {
                    orderId:     esc.orderId.toString(),
                    buyerId:     esc.buyerId.toString(),
                    amountCents: dispute.amount,
                    source:      'stripe_chargeback',
                });
                console.log(`[PAYMENT] Stripe dispute created for order ${esc.orderId} — escrow frozen`);
            }
        }
        // Stripe dispute closed — unfreeze if won, mark refunded if lost
        else if (event.type === 'charge.dispute.closed') {
            const dispute = event.data.object;
            const esc     = await Escrow.findOne({ stripeChargeId: dispute.charge });
            if (esc) {
                if (dispute.status === 'won') {
                    esc.frozen = false;
                    await esc.save();
                    await logEvent(esc.orderId, 'stripe_dispute_won', null, 'stripe_webhook', { disputeId: dispute.id });
                    console.log(`[PAYMENT] Stripe dispute WON for order ${esc.orderId} — escrow unfrozen`);
                } else if (dispute.status === 'lost') {
                    esc.status       = 'refunded';
                    esc.frozen       = false;
                    esc.refundReason = 'stripe_dispute_lost';
                    await esc.save();
                    await logEvent(esc.orderId, 'stripe_dispute_lost', null, 'stripe_webhook', { disputeId: dispute.id });
                    console.log(`[PAYMENT] Stripe dispute LOST for order ${esc.orderId} — escrow marked refunded`);
                }
            }
        }

        res.json({ received: true });
    } catch (err) {
        console.error('[PAYMENT] Webhook handler error:', err.message);
        res.status(500).json({ error: err.message });
    }
};

// ── Phase 3 — POST /create-intent — create Stripe PaymentIntent (manual capture) ──
// Called by checkout BEFORE order placement to get clientSecret for Stripe.js.
// Returns { clientSecret, intentId } to the client.
app.post('/create-intent', async (req, res) => {
    if (!req.user?.sub) return errorResponse(res, 401, 'Unauthorized');
    const { amountCents } = req.body;
    if (!amountCents || amountCents < 50) {
        return errorResponse(res, 400, 'amountCents must be at least 50');
    }
    try {
        const cfg          = await getPlatformConfig().catch(() => ({ defaultCurrency: 'cad' }));
        const currency     = cfg.defaultCurrency || 'cad';
        const providerName = process.env.PAYMENT_PROVIDER || (STRIPE_SECRET_KEY_AT_LOAD ? 'stripe' : 'mock');
        const provider     = getProvider(providerName);

        // Fetch the user's Stripe Customer ID so saved PaymentMethods can be reused.
        // Without customer on the PaymentIntent, Stripe rejects any saved card.
        let stripeCustomerId = null;
        try {
            const userSvcUrl = process.env.USER_SERVICE_URL || 'http://localhost:5013';
            const userResp   = await fetch(`${userSvcUrl}/users/internal/${req.user.sub}/stripe-data`, {
                headers: { 'x-internal-service': 'payment-service' },
            });
            if (userResp.ok) {
                const userData   = await userResp.json();
                stripeCustomerId = userData.stripeCustomerId || null;
            }
        } catch (_) { /* non-fatal — proceed without customer */ }

        const result = await provider.authorize({
            amountCents,
            currency,
            orderId:            req.user.sub,   // temporary buyer reference before orderId is assigned
            stripeCustomerId,
        });
        res.json({ clientSecret: result.clientSecret, intentId: result.intentId });
    } catch (err) {
        console.error('[PAYMENT] create-intent error:', err.message);
        errorResponse(res, 500, `Payment setup failed: ${err.message}`);
    }
});

// ── Routes ───────────────────────────────────────────────────────────────────

// S12 — GET /escrow/:orderId — secured (R4)
app.get('/escrow/:orderId', async (req, res) => {
    try {
        const esc = await Escrow.findOne({ orderId: req.params.orderId });
        if (!esc) return errorResponse(res, 404, 'Escrow not found');

        const userId  = req.user?.sub;
        const storeId = req.user?.storeId;
        const isAdmin = req.user?.role === 'admin';
        const isBuyer  = userId  && esc.buyerId?.toString() === userId;
        const isSeller = storeId && esc.sellerPayouts.some(p => p.sellerId?.toString() === storeId);

        if (!isBuyer && !isSeller && !isAdmin) {
            return errorResponse(res, 403, 'Access denied — not a party to this escrow');
        }

        res.json(esc);
    } catch (err) { errorResponse(res, 500, err.message); }
});

// S13 — GET /my-orders — buyer payment history (R7)
app.get('/my-orders', async (req, res) => {
    if (!req.user?.sub) return errorResponse(res, 401, 'Unauthorized');
    try {
        const escrows = await Escrow.find({ buyerId: req.user.sub }).sort({ createdAt: -1 });
        const result = escrows.map(esc => ({
            orderId:                esc.orderId,
            amountCents:            esc.amountCents ?? esc.amount ?? 0,
            status:                 esc.status,
            paymentMethod:          esc.paymentMethod,
            disputeWindowExpiresAt: esc.disputeWindowExpiresAt,
            releasedAt:             esc.releasedAt,
            createdAt:              esc.createdAt
            // sellerPayouts deliberately excluded — buyer should not see per-seller split
        }));
        res.json(result);
    } catch (err) { errorResponse(res, 500, err.message); }
});

// S14 — GET /seller-payouts — seller payout history, paginated (R8)
app.get('/seller-payouts', async (req, res) => {
    if (!req.user?.storeId) return errorResponse(res, 400, 'Seller context required (storeId missing from token)');
    try {
        const storeId = req.user.storeId;
        const page    = Math.max(1, parseInt(req.query.page  || '1'));
        const limit   = Math.min(50, parseInt(req.query.limit || '20'));
        const skip    = (page - 1) * limit;

        const all   = await Escrow.find({ 'sellerPayouts.sellerId': storeId }).sort({ createdAt: -1 });
        const total = all.length;
        const slice = all.slice(skip, skip + limit);

        const payouts = slice.map(esc => {
            const payout = esc.sellerPayouts.find(p => p.sellerId?.toString() === storeId);
            return {
                orderId:          esc.orderId,
                amountCents:      payout?.amountCents      ?? payout?.amount ?? 0,
                netAmountCents:   payout?.netAmountCents   ?? payout?.amountCents ?? payout?.amount ?? 0,
                platformFeeCents: payout?.platformFeeCents ?? 0,
                released:         payout?.released ?? false,
                releasedAt:       esc.releasedAt,
                paymentMethod:    esc.paymentMethod,
                createdAt:        esc.createdAt
            };
        });

        res.json({ payouts, total, page, hasMore: skip + limit < total });
    } catch (err) { errorResponse(res, 500, err.message); }
});

// S5 — PATCH /collect/:orderId — COD collection (R3)
app.patch('/collect/:orderId', async (req, res) => {
    try {
        const esc = await Escrow.findOne({ orderId: req.params.orderId });
        if (!esc) return errorResponse(res, 404, 'Escrow not found');
        if (esc.paymentMethod !== 'cod') return errorResponse(res, 400, 'Not a COD order');
        if (esc.status !== 'cod_pending') return errorResponse(res, 400, `Escrow not in cod_pending state (current: ${esc.status})`);

        const storeId = req.user?.storeId;
        const isSeller = storeId && esc.sellerPayouts.some(p => p.sellerId?.toString() === storeId);
        if (!isSeller) return errorResponse(res, 403, 'Only the seller on this order can mark COD collection');

        const now = new Date();
        esc.status         = 'released';
        esc.releasedAt     = now;
        esc.codCollectedAt = now;
        esc.sellerPayouts.forEach(p => { p.released = true; });
        await esc.save();

        await logEvent(esc.orderId, 'cod_collected', storeId, 'seller', {
            collectedAt: now,
            amountCents: esc.amountCents ?? esc.amount ?? 0
        });

        bus.emit('payment.collected', {
            orderId:     esc.orderId,
            buyerId:     esc.buyerId,
            sellerId:    storeId,
            amountCents: esc.amountCents ?? esc.amount ?? 0,
            collectedAt: now
        });

        console.log(`[PAYMENT] COD collected for order ${esc.orderId} by seller ${storeId}`);
        res.json(esc);
    } catch (err) { errorResponse(res, 500, err.message); }
});

// S9 — POST /dispute/:orderId — buyer dispute hold (R10)
app.post('/dispute/:orderId', async (req, res) => {
    try {
        const esc = await Escrow.findOne({ orderId: req.params.orderId });
        if (!esc) return errorResponse(res, 404, 'Escrow not found');

        const userId  = req.user?.sub;
        if (!userId || esc.buyerId?.toString() !== userId) {
            return errorResponse(res, 403, 'Only the buyer can file a dispute');
        }
        if (esc.status !== 'held') {
            return errorResponse(res, 400, `Cannot dispute escrow in status '${esc.status}' — must be 'held'`);
        }
        if (!esc.disputeWindowExpiresAt || esc.disputeWindowExpiresAt <= new Date()) {
            return errorResponse(res, 400, 'Dispute window has expired — contact support');
        }
        if (esc.disputeHeld) {
            return errorResponse(res, 400, 'Dispute already filed for this order');
        }

        esc.disputeHeld = true;
        esc.status      = 'disputed';
        await esc.save();

        await logEvent(esc.orderId, 'payment_disputed', userId, 'buyer', {
            disputedAt:             new Date(),
            disputeWindowExpiresAt: esc.disputeWindowExpiresAt
        });

        bus.emit('payment.disputed', {
            orderId:     esc.orderId,
            buyerId:     esc.buyerId,
            amountCents: esc.amountCents ?? esc.amount ?? 0
        });

        console.log(`[PAYMENT] Dispute filed for order ${esc.orderId} by buyer ${userId}`);
        res.json({ orderId: esc.orderId, disputeHeld: true, message: 'Dispute filed. Admin will review.' });
    } catch (err) { errorResponse(res, 500, err.message); }
});

// S10 — POST /refund/:orderId — full refund (R5)
app.post('/refund/:orderId', async (req, res) => {
    try {
        const isAdmin = req.user?.role === 'admin' || !!req.headers['x-admin-email'];
        const reason  = req.body.reason || (isAdmin ? 'admin_action' : '');
        if (!reason) return errorResponse(res, 400, 'reason is required');

        const esc = await Escrow.findOne({ orderId: req.params.orderId });
        if (!esc) return errorResponse(res, 404, 'Escrow not found');

        const userId  = req.user?.sub;
        const isBuyer = userId && esc.buyerId?.toString() === userId;

        if (!isAdmin && !isBuyer) {
            return errorResponse(res, 403, 'Only admin or the buyer can initiate a refund');
        }
        if (!['held', 'disputed'].includes(esc.status)) {
            return errorResponse(res, 400, `Cannot refund escrow in status '${esc.status}'`);
        }
        if (isBuyer && !isAdmin) {
            if (!esc.disputeWindowExpiresAt || esc.disputeWindowExpiresAt <= new Date()) {
                return errorResponse(res, 403, 'Dispute window has expired — only admin can issue a refund now');
            }
        }

        // S9 — Call Stripe to refund (if captured) or cancel intent (if not yet captured)
        if (esc.provider === 'stripe') {
            const provider = getProvider('stripe');
            try {
                if (esc.stripeChargeId) {
                    const refundResult = await provider.refund({
                        chargeId:       esc.stripeChargeId,
                        amountCents:    esc.amountCents ?? esc.amount ?? 0,
                        reason,
                        idempotencyKey: `refund-full-${req.params.orderId}`,
                    });
                    esc.stripeRefundId = refundResult.refundId;
                } else if (esc.stripePaymentIntentId) {
                    await provider.cancel({ intentId: esc.stripePaymentIntentId });
                }
            } catch (stripeErr) {
                return errorResponse(res, 502, `Payment provider refund failed: ${stripeErr.message}`);
            }
        }

        const amountCents = esc.amountCents ?? esc.amount ?? 0;
        esc.status        = 'refunded';
        esc.refundReason  = reason;
        await esc.save();

        const actorRole = isAdmin ? 'admin' : 'buyer';
        await logEvent(esc.orderId, 'payment_refunded', userId, actorRole, { reason });

        bus.emit('payment.refunded', {
            orderId:     esc.orderId,
            buyerId:     esc.buyerId,
            amountCents,
            reason
        });

        console.log(`[PAYMENT] Refund issued for order ${esc.orderId} by ${actorRole}`);
        res.json(esc);
    } catch (err) { errorResponse(res, 500, err.message); }
});

// S9 — POST /partial-refund/:orderId — partial refund (R6)
app.post('/partial-refund/:orderId', async (req, res) => {
    try {
        if (!req.headers['x-admin-email'] && req.user?.role !== 'admin') return errorResponse(res, 403, 'Admin only');

        // S9 — buyerPercent (0–100) determines the partial refund amount from total escrow
        const { buyerPercent, reason, sellerId } = req.body;
        if (buyerPercent === undefined || buyerPercent < 0 || buyerPercent > 100 || !reason) {
            return errorResponse(res, 400, 'buyerPercent (0–100) and reason are required');
        }

        const esc = await Escrow.findOne({ orderId: req.params.orderId });
        if (!esc) return errorResponse(res, 404, 'Escrow not found');

        const partialAmountCents = Math.round((esc.amountCents ?? 0) * buyerPercent / 100);

        // S9 — Call Stripe to issue partial refund (if charge captured)
        if (esc.provider === 'stripe' && esc.stripeChargeId) {
            const provider = getProvider('stripe');
            try {
                const refundResult = await provider.refund({
                    chargeId:       esc.stripeChargeId,
                    amountCents:    partialAmountCents,
                    reason,
                    idempotencyKey: `refund-partial-${req.params.orderId}-${buyerPercent}`,
                });
                if (refundResult.refundId && !esc.stripeRefundId) {
                    esc.stripeRefundId = refundResult.refundId;
                }
            } catch (stripeErr) {
                return errorResponse(res, 502, `Payment provider partial refund failed: ${stripeErr.message}`);
            }
        }

        // Adjust seller payout if sellerId provided
        if (sellerId) {
            const payout = esc.sellerPayouts.find(p => p.sellerId?.toString() === sellerId);
            if (payout) {
                const gross          = payout.amountCents ?? payout.amount ?? 0;
                const newGross       = Math.max(0, gross - partialAmountCents);
                const newPlatformFee = Math.floor(newGross * (esc.feePercent || 0) / 100);
                payout.amountCents      = newGross;
                payout.platformFeeCents = newPlatformFee;
                payout.netAmountCents   = newGross - newPlatformFee;
                if (payout.released) payout.released = false;
            }
        }
        await esc.save();

        await logEvent(esc.orderId, 'partial_refund', req.user.sub, 'admin', {
            buyerPercent,
            partialAmountCents,
            reason
        });

        bus.emit('payment.partial_refunded', {
            orderId:     esc.orderId,
            buyerId:     esc.buyerId,
            amountCents: partialAmountCents,
            reason
        });

        console.log(`[PAYMENT] Partial refund of ${partialAmountCents} cents (${buyerPercent}%) for order ${esc.orderId}`);
        res.json(esc);
    } catch (err) { errorResponse(res, 500, err.message); }
});

// S9 — POST /cancel-intent/:orderId — cancel PaymentIntent before capture (buyer or admin)
app.post('/cancel-intent/:orderId', async (req, res) => {
    try {
        const esc = await Escrow.findOne({ orderId: req.params.orderId });
        if (!esc) return errorResponse(res, 404, 'Escrow not found');

        if (['released', 'refunded'].includes(esc.status)) {
            return errorResponse(res, 400, `Cannot cancel intent — escrow already in '${esc.status}' state`);
        }
        if (esc.stripeChargeId) {
            return errorResponse(res, 400, 'Payment has already been captured — use POST /refund instead');
        }

        const isAdmin = req.user?.role === 'admin' || !!req.headers['x-admin-email'];
        const userId  = req.user?.sub;
        const isBuyer = userId && esc.buyerId?.toString() === userId;
        if (!isAdmin && !isBuyer) {
            return errorResponse(res, 403, 'Only admin or buyer can cancel a pending payment');
        }

        if (esc.provider === 'stripe' && esc.stripePaymentIntentId) {
            const provider = getProvider('stripe');
            try {
                await provider.cancel({ intentId: esc.stripePaymentIntentId });
            } catch (stripeErr) {
                return errorResponse(res, 502, `Stripe cancel failed: ${stripeErr.message}`);
            }
        }

        esc.status       = 'refunded';
        esc.refundReason = req.body.reason || 'buyer_cancelled';
        await esc.save();
        await logEvent(esc.orderId, 'intent_cancelled', userId, isAdmin ? 'admin' : 'buyer', { reason: esc.refundReason });

        bus.emit('payment.cancelled', {
            orderId: esc.orderId.toString(),
            buyerId: esc.buyerId.toString(),
        });

        console.log(`[PAYMENT] Intent cancelled for order ${esc.orderId}`);
        res.json({ orderId: esc.orderId, status: 'refunded' });
    } catch (err) { errorResponse(res, 500, err.message); }
});

// S15 — PATCH /release/:orderId — admin manual release (C2)
app.patch('/release/:orderId', async (req, res) => {
    try {
        if (!req.headers['x-admin-email'] && req.user?.role !== 'admin') return errorResponse(res, 403, 'Admin only');

        const { reason } = req.body;
        const esc = await Escrow.findOne({ orderId: req.params.orderId });
        if (!esc) return errorResponse(res, 404, 'Escrow not found');

        if (['released', 'refunded'].includes(esc.status)) {
            return errorResponse(res, 400, `Escrow already in terminal state: '${esc.status}'`);
        }

        const now = new Date();
        esc.status     = 'released';
        esc.releasedAt = now;
        esc.sellerPayouts.forEach(p => { p.released = true; });
        await esc.save();

        await logEvent(esc.orderId, 'admin_released', req.headers['x-admin-email'] || req.user?.sub || req.user?.email, 'admin', { reason, releasedAt: now });

        const sellerIds = esc.sellerPayouts.map(p => p.sellerId?.toString()).filter(Boolean);
        bus.emit('payment.released', {
            orderId:     esc.orderId,
            buyerId:     esc.buyerId,
            sellerIds,
            amountCents: esc.amountCents ?? esc.amount ?? 0,
            reason
        });

        console.log(`[PAYMENT] Admin released escrow for order ${esc.orderId}. Reason: ${reason}`);
        res.json(esc);
    } catch (err) { errorResponse(res, 500, err.message); }
});

// S16 — GET /analytics — admin payment analytics (C4)
app.get('/analytics', async (req, res) => {
    try {
        if (!req.headers['x-admin-email'] && req.user?.role !== 'admin') return errorResponse(res, 403, 'Admin only');

        const escrows = await Escrow.find();
        let gmvCents = 0, totalHeldCents = 0, totalReleasedCents = 0,
            totalRefundedCents = 0, platformRevenueCents = 0,
            escrowCount = 0, codCount = 0, refundCount = 0, disputeCount = 0;

        for (const esc of escrows) {
            const amount = esc.amountCents ?? esc.amount ?? 0;
            gmvCents += amount;
            if (esc.paymentMethod === 'cod') codCount++;
            else escrowCount++;
            if (esc.status === 'held' || esc.status === 'disputed') totalHeldCents += amount;
            if (esc.status === 'released')  totalReleasedCents  += amount;
            if (esc.status === 'refunded')  { totalRefundedCents += amount; refundCount++; }
            if (esc.status === 'disputed')  disputeCount++;
            for (const p of esc.sellerPayouts) {
                platformRevenueCents += p.platformFeeCents ?? 0;
            }
        }

        const orderCount = escrows.length;
        res.json({
            gmvCents,
            totalHeldCents,
            totalReleasedCents,
            totalRefundedCents,
            platformRevenueCents,
            avgOrderValueCents: orderCount ? Math.round(gmvCents / orderCount) : 0,
            methodBreakdown:    { escrow: escrowCount, cod: codCount },
            refundRate:         orderCount ? Math.round((refundCount  / orderCount) * 10000) / 100 : 0,
            disputeRate:        orderCount ? Math.round((disputeCount / orderCount) * 10000) / 100 : 0,
            orderCount
        });
    } catch (err) { errorResponse(res, 500, err.message); }
});

// GET /admin/disputes — all disputed escrows
app.get('/admin/disputes', async (req, res) => {
    try {
        if (!req.headers['x-admin-email'] && req.user?.role !== 'admin') return errorResponse(res, 403, 'Admin only');
        const disputes = await Escrow.find({ status: 'disputed' }).sort({ 'disputeInfo.filedAt': 1 });
        res.json({ disputes, total: disputes.length });
    } catch (err) { errorResponse(res, 500, err.message); }
});

// GET /admin/summary — platform payment summary
app.get('/admin/summary', async (req, res) => {
    try {
        if (!req.headers['x-admin-email'] && req.user?.role !== 'admin') return errorResponse(res, 403, 'Admin only');
        const escrows = await Escrow.find();
        let totalHeld = 0, totalReleased = 0, totalRefunded = 0, platformRevenue = 0, disputeCount = 0;
        for (const esc of escrows) {
            const amount = esc.amountCents ?? esc.amount ?? 0;
            if (esc.status === 'held' || esc.status === 'disputed') totalHeld += amount;
            if (esc.status === 'released') totalReleased += amount;
            if (esc.status === 'refunded') totalRefunded += amount;
            if (esc.status === 'disputed') disputeCount++;
            for (const p of esc.sellerPayouts || []) {
                platformRevenue += p.platformFeeCents ?? 0;
            }
        }
        res.json({
            totalHeldCents: totalHeld,
            totalReleasedCents: totalReleased,
            totalRefundedCents: totalRefunded,
            platformRevenueCents: platformRevenue,
            disputeCount,
            orderCount: escrows.length
        });
    } catch (err) { errorResponse(res, 500, err.message); }
});

// PATCH /admin/escrows/:orderId/freeze — freeze escrow (admin)
app.patch('/admin/escrows/:orderId/freeze', async (req, res) => {
    try {
        if (!req.headers['x-admin-email'] && req.user?.role !== 'admin') return errorResponse(res, 403, 'Admin only');
        const escrow = await Escrow.findOneAndUpdate(
            { orderId: req.params.orderId },
            { frozen: true, frozenAt: new Date(), frozenBy: req.headers['x-admin-email'] || req.user?.sub || req.user?.email, frozenReason: req.body.reason || 'Admin hold' },
            { new: true }
        );
        if (!escrow) return errorResponse(res, 404, 'Escrow not found');
        res.json(escrow);
    } catch (err) { errorResponse(res, 500, err.message); }
});

// PATCH /admin/escrows/:orderId/unfreeze — unfreeze escrow (admin)
app.patch('/admin/escrows/:orderId/unfreeze', async (req, res) => {
    try {
        if (!req.headers['x-admin-email'] && req.user?.role !== 'admin') return errorResponse(res, 403, 'Admin only');
        const escrow = await Escrow.findOneAndUpdate(
            { orderId: req.params.orderId },
            { frozen: false, frozenAt: null, frozenBy: null, frozenReason: '' },
            { new: true }
        );
        if (!escrow) return errorResponse(res, 404, 'Escrow not found');
        await logEvent(escrow.orderId, 'admin_unfrozen', req.headers['x-admin-email'] || req.user?.sub || req.user?.email, 'admin', { reason: req.body.reason || 'Admin unfroze' });
        res.json(escrow);
    } catch (err) { errorResponse(res, 500, err.message); }
});

// POST /admin/escrows/:orderId/force-release — admin force release escrow
app.post('/admin/escrows/:orderId/force-release', async (req, res) => {
    try {
        if (!req.headers['x-admin-email'] && req.user?.role !== 'admin') return errorResponse(res, 403, 'Admin only');
        const { reason } = req.body;
        const escrow = await Escrow.findOne({ orderId: req.params.orderId });
        if (!escrow) return errorResponse(res, 404, 'Escrow not found');
        const now = new Date();
        escrow.status     = 'released';
        escrow.releasedAt = now;
        escrow.sellerPayouts.forEach(p => { p.released = true; });
        await escrow.save();
        await logEvent(escrow.orderId, 'admin_force_released', req.headers['x-admin-email'] || req.user?.sub || req.user?.email, 'admin', { reason: reason || 'admin_action', releasedAt: now });
        const sellerIds = escrow.sellerPayouts.map(p => p.sellerId?.toString()).filter(Boolean);
        bus.emit('payment.released', { orderId: req.params.orderId, sellerIds, adminForce: true, reason: reason || 'admin_action' });
        res.json(escrow);
    } catch (err) { errorResponse(res, 500, err.message); }
});

// S19 — Internal summary: pending payout total for one seller (no JWT — service-to-service)
app.get('/seller-summary/:sellerId', async (req, res) => {
    try {
        const { sellerId } = req.params;
        const escrows = await Escrow.find({
            'sellerPayouts.sellerId': new mongoose.Types.ObjectId(sellerId),
            status: { $in: ['held', 'cod_pending', 'authorizing'] },
        }).select('sellerPayouts').lean();

        let pendingPayouts = 0;
        for (const esc of escrows) {
            for (const p of (esc.sellerPayouts || [])) {
                if (p.sellerId?.toString() === sellerId && !p.released) {
                    pendingPayouts += p.netAmountCents || p.amountCents || 0;
                }
            }
        }
        res.json({ pendingPayouts });
    } catch (err) { errorResponse(res, 500, err.message); }
});

// S17 — GET /admin/escrows — paginated, filterable escrow list (C5)
// Internal: check if a user has active (held/disputed) escrows — used by admin proxy before hard-delete
// No standard auth required — called service-to-service with x-admin-email header
app.get('/admin/escrows/active-check', async (req, res) => {
    try {
        const { userId } = req.query;
        if (!userId) return errorResponse(res, 400, 'userId required');
        if (!mongoose.Types.ObjectId.isValid(userId)) return errorResponse(res, 400, 'Invalid userId format');
        const count = await Escrow.countDocuments({
            buyerId: new mongoose.Types.ObjectId(userId),
            status:  { $in: ['held', 'disputed'] }
        });
        res.json({ hasActive: count > 0, count });
    } catch (err) { errorResponse(res, 500, err.message); }
});

app.get('/admin/escrows', async (req, res) => {
    try {
        if (!req.headers['x-admin-email'] && req.user?.role !== 'admin') return errorResponse(res, 403, 'Admin only');

        const { status, paymentMethod, buyerId, sellerId, from, to } = req.query;
        const page  = Math.max(1, parseInt(req.query.page  || '1'));
        const limit = Math.min(100, parseInt(req.query.limit || '50'));
        const skip  = (page - 1) * limit;

        const filter = {};
        if (status)        filter.status        = status;
        if (paymentMethod) filter.paymentMethod  = paymentMethod;
        if (buyerId)       filter.buyerId        = buyerId;
        if (sellerId)      filter['sellerPayouts.sellerId'] = sellerId;
        if (from || to) {
            filter.createdAt = {};
            if (from) filter.createdAt.$gte = new Date(from);
            if (to)   filter.createdAt.$lte = new Date(to);
        }

        const [escrows, total] = await Promise.all([
            Escrow.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit),
            Escrow.countDocuments(filter)
        ]);

        res.json({ escrows, total, page, hasMore: skip + limit < total });
    } catch (err) { errorResponse(res, 500, err.message); }
});

// S18 — GET /admin/escrows/:orderId/log — audit log (C3)
app.get('/admin/escrows/:orderId/log', async (req, res) => {
    try {
        if (!req.headers['x-admin-email'] && req.user?.role !== 'admin') return errorResponse(res, 403, 'Admin only');
        const logs = await EventLog.find({ orderId: req.params.orderId }).sort({ timestamp: 1 });
        res.json(logs);
    } catch (err) { errorResponse(res, 500, err.message); }
});

// ── Admin Routes ─────────────────────────────────────────────────────────────

// PayoutHold model — tracks per-seller payout freezes
const PayoutHold = db.model('PayoutHold', new mongoose.Schema({
    sellerId: { type: mongoose.Schema.Types.ObjectId, required: true, unique: true },
    reason:   String,
    heldAt:   Date,
    heldBy:   String
}));

// PATCH /admin/escrows/:orderId/split-refund — split escrow between buyer and seller
app.patch('/admin/escrows/:orderId/split-refund', async (req, res) => {
    if (!req.headers['x-admin-email'] && req.user?.role !== 'admin') return errorResponse(res, 403, 'Admin only');
    const { buyerPercent, reason } = req.body;
    if (buyerPercent === undefined || buyerPercent < 0 || buyerPercent > 100) {
        return errorResponse(res, 400, 'buyerPercent must be between 0 and 100');
    }
    try {
        const esc = await Escrow.findOne({ orderId: req.params.orderId });
        if (!esc) return errorResponse(res, 404, 'Escrow not found');
        const amountCents  = esc.amountCents ?? esc.amount ?? 0;
        const refundAmount = Math.round(amountCents * buyerPercent / 100);
        const sellerAmount = amountCents - refundAmount;
        esc.status = 'split_resolved';
        await esc.save();
        await logEvent(esc.orderId, 'split_refund', req.headers['x-admin-email'] || req.user?.sub || req.user?.email, 'admin', {
            buyerPercent, refundAmount, sellerAmount, reason: reason || ''
        });
        bus.emit('payment.split_resolved', {
            orderId: esc.orderId, buyerPercent, refundAmount, sellerAmount, reason: reason || ''
        });
        res.json({ orderId: esc.orderId, buyerPercent, refundAmount, sellerAmount, reason: reason || '' });
    } catch (err) { errorResponse(res, 500, err.message); }
});

// PATCH /admin/escrows/:orderId/extend-dispute-window — extend dispute window
app.patch('/admin/escrows/:orderId/extend-dispute-window', async (req, res) => {
    if (!req.headers['x-admin-email'] && req.user?.role !== 'admin') return errorResponse(res, 403, 'Admin only');
    const { hours, reason } = req.body;
    if (!hours || hours <= 0) return errorResponse(res, 400, 'hours must be a positive number');
    try {
        const esc = await Escrow.findOne({ orderId: req.params.orderId });
        if (!esc) return errorResponse(res, 404, 'Escrow not found');
        const current = esc.disputeWindowExpiresAt ? new Date(esc.disputeWindowExpiresAt).getTime() : Date.now();
        esc.disputeWindowExpiresAt = new Date(current + hours * 3600000);
        await esc.save();
        await logEvent(esc.orderId, 'dispute_window_extended', req.headers['x-admin-email'] || req.user?.sub || req.user?.email, 'admin', {
            hours, newExpiresAt: esc.disputeWindowExpiresAt, reason: reason || ''
        });
        res.json({ orderId: esc.orderId, disputeWindowExpiresAt: esc.disputeWindowExpiresAt });
    } catch (err) { errorResponse(res, 500, err.message); }
});

// POST /admin/payments/hold-payouts/:sellerId — place payout hold on seller
app.post('/admin/payments/hold-payouts/:sellerId', async (req, res) => {
    if (!req.headers['x-admin-email'] && req.user?.role !== 'admin') return errorResponse(res, 403, 'Admin only');
    const { reason } = req.body;
    try {
        const hold = await PayoutHold.findOneAndUpdate(
            { sellerId: req.params.sellerId },
            { sellerId: req.params.sellerId, reason: reason || '', heldAt: new Date(), heldBy: req.user?.email || req.user?.sub || '' },
            { upsert: true, new: true }
        );
        res.status(201).json(hold);
    } catch (err) { errorResponse(res, 500, err.message); }
});

// DELETE /admin/payments/hold-payouts/:sellerId — lift payout hold
app.delete('/admin/payments/hold-payouts/:sellerId', async (req, res) => {
    if (!req.headers['x-admin-email'] && req.user?.role !== 'admin') return errorResponse(res, 403, 'Admin only');
    try {
        await PayoutHold.deleteOne({ sellerId: req.params.sellerId });
        res.json({ ok: true, sellerId: req.params.sellerId });
    } catch (err) { errorResponse(res, 500, err.message); }
});

// GET /admin/payments/payout-holds — list all sellers under payout hold
app.get('/admin/payments/payout-holds', async (req, res) => {
    if (!req.headers['x-admin-email'] && req.user?.role !== 'admin') return errorResponse(res, 403, 'Admin only');
    try {
        const holds = await PayoutHold.find().sort({ heldAt: -1 });
        res.json(holds);
    } catch (err) { errorResponse(res, 500, err.message); }
});

// ── S21 — Saved Cards ─────────────────────────────────────────────────────────

// GET /saved-cards — list buyer's saved Stripe PaymentMethods
app.get('/saved-cards', async (req, res) => {
    if (!req.user?.sub) return errorResponse(res, 401, 'Unauthorized');
    if (!process.env.STRIPE_SECRET_KEY) return res.json({ cards: [] });
    try {
        const stripeProvider = getProvider('stripe');
        const userSvcUrl     = process.env.USER_SERVICE_URL || 'http://localhost:5013';
        const userResp       = await fetch(`${userSvcUrl}/users/internal/${req.user.sub}/stripe-data`, {
            headers: { 'x-internal-service': 'payment-service' },
        });
        if (!userResp.ok) return res.json({ cards: [] });
        const { stripeCustomerId } = await userResp.json();
        if (!stripeCustomerId) return res.json({ cards: [] });

        const pms   = await stripeProvider.stripe.paymentMethods.list({ customer: stripeCustomerId, type: 'card' });
        const cards = (pms.data || []).map(pm => ({
            id:       pm.id,
            brand:    pm.card?.brand    || 'card',
            last4:    pm.card?.last4    || '????',
            expMonth: pm.card?.exp_month,
            expYear:  pm.card?.exp_year,
        }));
        res.json({ cards });
    } catch (err) { errorResponse(res, 500, err.message); }
});

// POST /saved-cards/:pmId/delete — detach a saved PaymentMethod
app.post('/saved-cards/:pmId/delete', async (req, res) => {
    if (!req.user?.sub) return errorResponse(res, 401, 'Unauthorized');
    if (!process.env.STRIPE_SECRET_KEY) return errorResponse(res, 503, 'Stripe not configured');
    try {
        const stripeProvider = getProvider('stripe');
        const userSvcUrl     = process.env.USER_SERVICE_URL || 'http://localhost:5013';
        const userResp       = await fetch(`${userSvcUrl}/users/internal/${req.user.sub}/stripe-data`, {
            headers: { 'x-internal-service': 'payment-service' },
        });
        if (!userResp.ok) return errorResponse(res, 404, 'User profile not found');
        const { stripeCustomerId } = await userResp.json();
        if (!stripeCustomerId) return errorResponse(res, 404, 'No saved cards on account');

        // Verify the PM actually belongs to this customer before detaching
        const pm = await stripeProvider.stripe.paymentMethods.retrieve(req.params.pmId);
        if (pm.customer !== stripeCustomerId) {
            return errorResponse(res, 403, 'Payment method does not belong to this account');
        }
        await stripeProvider.stripe.paymentMethods.detach(req.params.pmId);
        res.json({ ok: true });
    } catch (err) { errorResponse(res, 500, err.message); }
});

// POST /setup-intent — create Stripe SetupIntent so buyer can save a card from wallet
app.post('/setup-intent', async (req, res) => {
    if (!req.user?.sub) return errorResponse(res, 401, 'Unauthorized');
    if (!process.env.STRIPE_SECRET_KEY) return errorResponse(res, 503, 'Stripe not configured');
    try {
        const stripeProvider = getProvider('stripe');
        const userSvcUrl     = process.env.USER_SERVICE_URL || 'http://localhost:5013';
        const userResp       = await fetch(`${userSvcUrl}/users/internal/${req.user.sub}/stripe-data`, {
            headers: { 'x-internal-service': 'payment-service' },
        });
        if (!userResp.ok) return errorResponse(res, 502, 'Could not reach user service');
        const userData       = await userResp.json();
        let stripeCustomerId = userData.stripeCustomerId || null;

        if (!stripeCustomerId) {
            const customer = await stripeProvider.stripe.customers.create({
                metadata: { userId: req.user.sub },
                email:    userData.email       || undefined,
                name:     userData.displayName || undefined,
            });
            stripeCustomerId = customer.id;
            bus.emit('user.stripe_customer_created', {
                userId:           req.user.sub,
                stripeCustomerId: stripeCustomerId,
            });
        }

        const setupIntent = await stripeProvider.stripe.setupIntents.create({
            customer:             stripeCustomerId,
            payment_method_types: ['card'],
            usage:                'off_session',
        });
        res.json({ clientSecret: setupIntent.client_secret });
    } catch (err) { errorResponse(res, 500, err.message); }
});

// ── S22 — Admin Business Rules UI ────────────────────────────────────────────

// GET /admin/platform-config — return current payment business rules config (admin only)
// Called from admin-service proxy (x-admin-email) or user JWT with role=admin
app.get('/admin/platform-config', async (req, res) => {
    const isAdmin = req.user?.role === 'admin' || !!req.headers['x-admin-email'];
    if (!isAdmin) return errorResponse(res, 403, 'Admin only');
    try {
        const cfg = await getPlatformConfig();
        res.json({
            sellerAcceptanceHours: cfg.sellerAcceptanceHours,
            codExpiryDays:         cfg.codExpiryDays,
            defaultCurrency:       cfg.defaultCurrency,
            taxRates:              cfg.taxRates ? Object.fromEntries(cfg.taxRates) : {},
        });
    } catch (err) { errorResponse(res, 500, err.message); }
});

// PATCH /admin/platform-config — update timing / currency fields (admin only)
// Called from admin-service proxy (x-admin-email) or user JWT with role=admin
// Handles: sellerAcceptanceHours, codExpiryDays, defaultCurrency
app.patch('/admin/platform-config', async (req, res) => {
    const isAdmin = req.user?.role === 'admin' || !!req.headers['x-admin-email'];
    if (!isAdmin) return errorResponse(res, 403, 'Admin only');
    const { sellerAcceptanceHours, codExpiryDays, defaultCurrency } = req.body;
    const update = {};
    if (sellerAcceptanceHours !== undefined) {
        const h = Number(sellerAcceptanceHours);
        if (!Number.isFinite(h) || h < 1 || h > 168) return errorResponse(res, 400, 'sellerAcceptanceHours must be 1–168');
        update.sellerAcceptanceHours = h;
    }
    if (codExpiryDays !== undefined) {
        const d = Number(codExpiryDays);
        if (!Number.isFinite(d) || d < 1 || d > 90) return errorResponse(res, 400, 'codExpiryDays must be 1–90');
        update.codExpiryDays = d;
    }
    if (defaultCurrency !== undefined) {
        if (typeof defaultCurrency !== 'string' || !/^[a-z]{3}$/.test(defaultCurrency)) {
            return errorResponse(res, 400, 'defaultCurrency must be a 3-letter ISO currency code');
        }
        update.defaultCurrency = defaultCurrency;
    }
    if (!Object.keys(update).length) return errorResponse(res, 400, 'No valid fields provided');
    try {
        const PlatformConfig = require('../shared/utils/platformConfig').getPlatformConfigModel();
        await PlatformConfig.findOneAndUpdate({}, { $set: update }, { upsert: true });
        invalidatePlatformConfigCache();
        res.json({ ok: true, updated: update });
    } catch (err) { errorResponse(res, 500, err.message); }
});

// PATCH /admin/platform-config/tax-rates — upsert a single tax rate entry (admin only)
// Called from admin-service proxy (x-admin-email) or user JWT with role=admin
app.patch('/admin/platform-config/tax-rates', async (req, res) => {
    const isAdmin = req.user?.role === 'admin' || !!req.headers['x-admin-email'];
    if (!isAdmin) return errorResponse(res, 403, 'Admin only');
    const { region, rate } = req.body;
    if (!region || typeof region !== 'string' || region.trim() === '') {
        return errorResponse(res, 400, 'region is required');
    }
    const rateNum = Number(rate);
    if (!Number.isFinite(rateNum) || rateNum < 0 || rateNum > 1) {
        return errorResponse(res, 400, 'rate must be a number between 0 and 1');
    }
    try {
        const PlatformConfig = require('../shared/utils/platformConfig').getPlatformConfigModel();
        const key = `taxRates.${region.trim()}`;
        await PlatformConfig.findOneAndUpdate({}, { $set: { [key]: rateNum } }, { upsert: true });
        invalidatePlatformConfigCache();
        res.json({ ok: true, region: region.trim(), rate: rateNum });
    } catch (err) { errorResponse(res, 500, err.message); }
});

// ── S23 — Manual Remittance ───────────────────────────────────────────────────
const RemittanceSchema = new mongoose.Schema({
    sellerId:        { type: mongoose.Schema.Types.ObjectId, required: true, index: true },
    storeId:         { type: mongoose.Schema.Types.ObjectId },
    orderIds:        [{ type: mongoose.Schema.Types.ObjectId }],
    amountCents:     { type: Number, required: true, min: 1 },
    method:          { type: String, enum: ['bank_transfer', 'cheque', 'cash', 'interac', 'other'], default: 'bank_transfer' },
    referenceNumber: { type: String, trim: true },
    note:            { type: String, trim: true },
    status:          { type: String, enum: ['pending', 'paid'], default: 'pending', index: true },
    paidAt:          { type: Date },
    createdBy:       { type: String, required: true },  // admin email
    createdAt:       { type: Date, default: Date.now, index: true },
}, { collection: 'remittances' });

const Remittance = db.model('Remittance', RemittanceSchema);

// GET /admin/payments/remittances — list with optional filters
app.get('/admin/payments/remittances', async (req, res) => {
    const isAdmin = req.user?.role === 'admin' || !!req.headers['x-admin-email'];
    if (!isAdmin) return errorResponse(res, 403, 'Admin only');
    try {
        const { sellerId, status, from, to, page = 1, limit = 50 } = req.query;
        const filter = {};
        if (sellerId) filter.sellerId = sellerId;
        if (status)   filter.status = status;
        if (from || to) {
            filter.createdAt = {};
            if (from) filter.createdAt.$gte = new Date(from);
            if (to)   filter.createdAt.$lte = new Date(to);
        }
        const skip  = (parseInt(page) - 1) * parseInt(limit);
        const total = await Remittance.countDocuments(filter);
        const rows  = await Remittance.find(filter).sort({ createdAt: -1 }).skip(skip).limit(parseInt(limit));
        res.json({ total, page: parseInt(page), limit: parseInt(limit), rows });
    } catch (err) { errorResponse(res, 500, err.message); }
});

// POST /admin/payments/remittances — create remittance record
app.post('/admin/payments/remittances', async (req, res) => {
    const adminEmail = req.headers['x-admin-email'] || req.user?.email;
    const isAdmin    = req.user?.role === 'admin' || !!req.headers['x-admin-email'];
    if (!isAdmin) return errorResponse(res, 403, 'Admin only');
    const { sellerId, storeId, orderIds, amountCents, method, referenceNumber, note } = req.body;
    if (!sellerId)   return errorResponse(res, 400, 'sellerId is required');
    if (!amountCents || amountCents < 1) return errorResponse(res, 400, 'amountCents must be >= 1');
    try {
        const rec = await Remittance.create({
            sellerId, storeId, orderIds: orderIds || [],
            amountCents, method: method || 'bank_transfer',
            referenceNumber, note,
            createdBy: adminEmail || 'admin',
        });
        res.status(201).json(rec);
    } catch (err) { errorResponse(res, 500, err.message); }
});

// PATCH /admin/payments/remittances/:id/mark-paid — mark a remittance as paid
app.patch('/admin/payments/remittances/:id/mark-paid', async (req, res) => {
    const isAdmin = req.user?.role === 'admin' || !!req.headers['x-admin-email'];
    if (!isAdmin) return errorResponse(res, 403, 'Admin only');
    try {
        const rec = await Remittance.findById(req.params.id);
        if (!rec) return errorResponse(res, 404, 'Remittance not found');
        if (rec.status === 'paid') return errorResponse(res, 409, 'Already marked paid');
        rec.status = 'paid';
        rec.paidAt = new Date();
        await rec.save();
        bus.emit('payment.remitted', {
            remittanceId: rec._id.toString(),
            sellerId:     rec.sellerId.toString(),
            storeId:      rec.storeId ? rec.storeId.toString() : null,
            amountCents:  rec.amountCents,
            method:       rec.method,
            referenceNumber: rec.referenceNumber || null,
            paidAt:       rec.paidAt.toISOString(),
        });
        res.json(rec);
    } catch (err) { errorResponse(res, 500, err.message); }
});

app.get('/health', (req, res) => {
    res.json({ service: 'payment-service', status: 'ok', dbState: db.readyState === 1 ? 'connected' : 'disconnected' });
});

app.listen(process.env.PORT || 5004, () => console.log(`Payment Service on port ${process.env.PORT || 5004}`));
