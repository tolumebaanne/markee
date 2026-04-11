require('dotenv').config({ path: require('path').join(__dirname, '.env') });
const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const parseUser = require('../shared/middleware/parseUser');
const platformGuard = require('../shared/middleware/platformGuard');
const errorResponse = require('../shared/utils/errorResponse');
const bus = require('../shared/eventBus');

const app = express();
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
    paymentMethod: { type: String, enum: ['escrow', 'cod'], default: 'escrow' },
    feePercent:    { type: Number, default: 0 },              // snapshot of PLATFORM_FEE_PERCENT at creation time
    status: {
        type:    String,
        enum:    ['held', 'released', 'refunded', 'disputed', 'cod_pending'],
        default: 'held'
    },
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
    const expiresAt = new Date(Date.now() + DISPUTE_WINDOW_HOURS * 60 * 60 * 1000);
    esc.disputeWindowExpiresAt = expiresAt;
    await esc.save();
    await logEvent(esc.orderId, 'dispute_window_started', null, 'system', {
        expiresAt,
        windowHours: DISPUTE_WINDOW_HOURS
    });
    console.log(`[PAYMENT] Dispute window set for order ${esc.orderId}, expires ${expiresAt.toISOString()}`);
}

// ── S8 — Release helper (used by sweep and buyer_confirmed) ──────────────────

async function releaseEscrow(esc, trigger, actorId = null, actorRole = 'system') {
    const now = new Date();
    esc.status     = 'released';
    esc.releasedAt = now;
    esc.sellerPayouts.forEach(p => { p.released = true; });
    await esc.save();

    const sellerIds = esc.sellerPayouts.map(p => p.sellerId?.toString()).filter(Boolean);
    await logEvent(esc.orderId, trigger, actorId, actorRole, {
        releasedAt: now,
        sellerIds,
        amountCents: esc.amountCents ?? esc.amount ?? 0
    });

    bus.emit('payment.auto_released', {
        orderId:     esc.orderId,
        buyerId:     esc.buyerId,
        sellerIds,
        amountCents: esc.amountCents ?? esc.amount ?? 0,
        releasedAt:  now
    });
    console.log(`[PAYMENT] Escrow released via ${trigger} for order ${esc.orderId}`);
}

// ── Event listeners ──────────────────────────────────────────────────────────

// S2/S4 — order.placed: branch on paymentMethod
bus.on('order.placed', async (payload) => {
    try {
        const paymentMethod = payload.paymentMethod || 'escrow';
        const { payouts, totalFee } = buildSellerPayouts(payload.items || [], PLATFORM_FEE_PERCENT);

        // S6 (C1) — COD buyer reputation gate (best-effort)
        if (paymentMethod === 'cod') {
            try {
                const sellerId = [...new Set((payload.items || []).map(i => i.sellerId?.toString()).filter(Boolean))][0];
                if (sellerId) {
                    const storeRes = await fetch(`http://localhost:5005/${sellerId}`).catch(() => null);
                    if (storeRes?.ok) {
                        const store = await storeRes.json();
                        const minScore = store.minCodBuyerScore || 0;
                        if (minScore > 0) {
                            const scoreRes = await fetch(`http://localhost:5008/seller/${payload.buyerId}/stats`).catch(() => null);
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

        const totalAmount = payload.totalAmount;
        const escrowStatus = paymentMethod === 'cod' ? 'cod_pending' : 'held';

        const esc = await Escrow.create({
            orderId:       payload.orderId,
            buyerId:       payload.buyerId,
            amountCents:   totalAmount,
            paymentMethod,
            feePercent:    PLATFORM_FEE_PERCENT,
            status:        escrowStatus,
            sellerPayouts: payouts
        });

        await logEvent(payload.orderId, 'escrow_created', payload.buyerId, 'buyer', {
            amountCents: totalAmount,
            paymentMethod,
            feePercent:  PLATFORM_FEE_PERCENT,
            totalPlatformFeeCents: totalFee
        });

        if (paymentMethod === 'cod') {
            bus.emit('payment.pending', {
                orderId:  esc.orderId,
                buyerId:  esc.buyerId,
                amountCents: esc.amountCents
            });
            console.log(`[PAYMENT] COD escrow (cod_pending) for order ${payload.orderId}, total: ${totalAmount}`);
        } else {
            bus.emit('payment.captured', {
                orderId:  esc.orderId,
                buyerId:  esc.buyerId,
                amount:   esc.amountCents,          // keep 'amount' key for order-service compat
                amountCents: esc.amountCents,
                sellerId: payouts[0]?.sellerId,      // primary seller
                sellerIds: payouts.map(p => p.sellerId.toString())
            });
            console.log(`[PAYMENT] Escrow held for order ${payload.orderId}, total: ${totalAmount}, fee: ${totalFee} (${PLATFORM_FEE_PERCENT}%)`);
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

// ── S8 — Dispute window sweep + COD expiry ────────────────────────────────────
// Two queries per run:
//   1. Auto-release: held escrowed orders past their dispute window with no active hold
//   2. COD expiry: cod_pending orders older than 7 days
// Fires immediately on startup (catches any windows that expired during downtime),
// then repeats every 30 minutes.

const SWEEP_INTERVAL_MS = 30 * 60 * 1000;
const COD_EXPIRY_DAYS   = 7;

async function runSweep() {
    const now = new Date();
    try {
        // Dispute window sweep
        const expired = await Escrow.find({
            status:                 'held',
            disputeHeld:            false,
            disputeWindowExpiresAt: { $lte: now }
        });
        for (const esc of expired) {
            await releaseEscrow(esc, 'dispute_window_expired', null, 'system');
        }
        if (expired.length) console.log(`[PAYMENT] Sweep released ${expired.length} escrows`);

        // COD expiry sweep (C7)
        const codCutoff = new Date(now - COD_EXPIRY_DAYS * 24 * 60 * 60 * 1000);
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
        const isAdmin = req.user?.role === 'admin';
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

        esc.status      = 'refunded';
        esc.refundReason = reason;
        await esc.save();

        const actorRole = isAdmin ? 'admin' : 'buyer';
        await logEvent(esc.orderId, 'payment_refunded', userId, actorRole, { reason });

        bus.emit('payment.refunded', {
            orderId:     esc.orderId,
            buyerId:     esc.buyerId,
            amountCents: esc.amountCents ?? esc.amount ?? 0,
            reason
        });

        console.log(`[PAYMENT] Refund issued for order ${esc.orderId} by ${actorRole}`);
        res.json(esc);
    } catch (err) { errorResponse(res, 500, err.message); }
});

// S11 — POST /partial-refund/:orderId — partial refund (R6)
app.post('/partial-refund/:orderId', async (req, res) => {
    try {
        if (req.user?.role !== 'admin') return errorResponse(res, 403, 'Admin only');

        const { sellerId, refundAmountCents, reason } = req.body;
        if (!sellerId || !refundAmountCents || !reason) {
            return errorResponse(res, 400, 'sellerId, refundAmountCents, and reason are required');
        }

        const esc = await Escrow.findOne({ orderId: req.params.orderId });
        if (!esc) return errorResponse(res, 404, 'Escrow not found');

        const payout = esc.sellerPayouts.find(p => p.sellerId?.toString() === sellerId);
        if (!payout) return errorResponse(res, 400, 'Seller not found in this escrow');

        const gross = payout.amountCents ?? payout.amount ?? 0;
        if (refundAmountCents > gross) {
            return errorResponse(res, 400, `Refund amount (${refundAmountCents}) exceeds seller payout (${gross})`);
        }

        // Recompute payout after deduction
        const newGross           = gross - refundAmountCents;
        const newPlatformFee     = Math.floor(newGross * (esc.feePercent || 0) / 100);
        payout.amountCents       = newGross;
        payout.platformFeeCents  = newPlatformFee;
        payout.netAmountCents    = newGross - newPlatformFee;
        if (payout.released) payout.released = false;
        await esc.save();

        await logEvent(esc.orderId, 'partial_refund', req.user.sub, 'admin', {
            sellerId,
            refundAmountCents,
            newPayoutAmountCents: newGross,
            reason
        });

        bus.emit('payment.partial_refunded', {
            orderId:          esc.orderId,
            buyerId:          esc.buyerId,
            sellerId,
            refundAmountCents,
            reason
        });

        console.log(`[PAYMENT] Partial refund of ${refundAmountCents} cents for seller ${sellerId} on order ${esc.orderId}`);
        res.json(esc);
    } catch (err) { errorResponse(res, 500, err.message); }
});

// S15 — PATCH /release/:orderId — admin manual release (C2)
app.patch('/release/:orderId', async (req, res) => {
    try {
        if (req.user?.role !== 'admin') return errorResponse(res, 403, 'Admin only');

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

        await logEvent(esc.orderId, 'admin_released', req.user.sub || req.user.email, 'admin', { reason, releasedAt: now });

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
        if (req.user?.role !== 'admin') return errorResponse(res, 403, 'Admin only');

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
        if (req.user?.role !== 'admin') return errorResponse(res, 403, 'Admin only');
        const disputes = await Escrow.find({ status: 'disputed' }).sort({ 'disputeInfo.filedAt': 1 });
        res.json({ disputes, total: disputes.length });
    } catch (err) { errorResponse(res, 500, err.message); }
});

// GET /admin/summary — platform payment summary
app.get('/admin/summary', async (req, res) => {
    try {
        if (req.user?.role !== 'admin') return errorResponse(res, 403, 'Admin only');
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
        if (req.user?.role !== 'admin') return errorResponse(res, 403, 'Admin only');
        const escrow = await Escrow.findOneAndUpdate(
            { orderId: req.params.orderId },
            { frozen: true },
            { new: true }
        );
        if (!escrow) return errorResponse(res, 404, 'Escrow not found');
        res.json(escrow);
    } catch (err) { errorResponse(res, 500, err.message); }
});

// POST /admin/escrows/:orderId/force-release — admin force release escrow
app.post('/admin/escrows/:orderId/force-release', async (req, res) => {
    try {
        if (req.user?.role !== 'admin') return errorResponse(res, 403, 'Admin only');
        const { reason } = req.body;
        const escrow = await Escrow.findOneAndUpdate(
            { orderId: req.params.orderId },
            { status: 'released', releasedAt: new Date() },
            { new: true }
        );
        if (!escrow) return errorResponse(res, 404, 'Escrow not found');
        bus.emit('payment.released', { orderId: req.params.orderId, adminForce: true, reason: reason || 'admin_action' });
        res.json(escrow);
    } catch (err) { errorResponse(res, 500, err.message); }
});

// S17 — GET /admin/escrows — paginated, filterable escrow list (C5)
// Internal: check if a user has active (held/disputed) escrows — used by admin proxy before hard-delete
// No standard auth required — called service-to-service with x-admin-email header
app.get('/admin/escrows/active-check', async (req, res) => {
    try {
        const { userId } = req.query;
        if (!userId) return errorResponse(res, 400, 'userId required');
        const count = await Escrow.countDocuments({
            buyerId: new mongoose.Types.ObjectId(userId),
            status:  { $in: ['held', 'disputed'] }
        });
        res.json({ hasActive: count > 0, count });
    } catch (err) { errorResponse(res, 500, err.message); }
});

app.get('/admin/escrows', async (req, res) => {
    try {
        if (req.user?.role !== 'admin') return errorResponse(res, 403, 'Admin only');

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
        if (req.user?.role !== 'admin') return errorResponse(res, 403, 'Admin only');
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
    if (req.user?.role !== 'admin') return errorResponse(res, 403, 'Admin only');
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
        await logEvent(esc.orderId, 'split_refund', req.user.sub || req.user.email, 'admin', {
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
    if (req.user?.role !== 'admin') return errorResponse(res, 403, 'Admin only');
    const { hours, reason } = req.body;
    if (!hours || hours <= 0) return errorResponse(res, 400, 'hours must be a positive number');
    try {
        const esc = await Escrow.findOne({ orderId: req.params.orderId });
        if (!esc) return errorResponse(res, 404, 'Escrow not found');
        const current = esc.disputeWindowExpiresAt ? new Date(esc.disputeWindowExpiresAt).getTime() : Date.now();
        esc.disputeWindowExpiresAt = new Date(current + hours * 3600000);
        await esc.save();
        await logEvent(esc.orderId, 'dispute_window_extended', req.user.sub || req.user.email, 'admin', {
            hours, newExpiresAt: esc.disputeWindowExpiresAt, reason: reason || ''
        });
        res.json({ orderId: esc.orderId, disputeWindowExpiresAt: esc.disputeWindowExpiresAt });
    } catch (err) { errorResponse(res, 500, err.message); }
});

// POST /admin/payments/hold-payouts/:sellerId — place payout hold on seller
app.post('/admin/payments/hold-payouts/:sellerId', async (req, res) => {
    if (req.user?.role !== 'admin') return errorResponse(res, 403, 'Admin only');
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
    if (req.user?.role !== 'admin') return errorResponse(res, 403, 'Admin only');
    try {
        await PayoutHold.deleteOne({ sellerId: req.params.sellerId });
        res.json({ ok: true, sellerId: req.params.sellerId });
    } catch (err) { errorResponse(res, 500, err.message); }
});

// GET /admin/payments/payout-holds — list all sellers under payout hold
app.get('/admin/payments/payout-holds', async (req, res) => {
    if (req.user?.role !== 'admin') return errorResponse(res, 403, 'Admin only');
    try {
        const holds = await PayoutHold.find().sort({ heldAt: -1 });
        res.json(holds);
    } catch (err) { errorResponse(res, 500, err.message); }
});

app.get('/health', (req, res) => {
    res.json({ service: 'payment-service', status: 'ok', dbState: db.readyState === 1 ? 'connected' : 'disconnected' });
});

app.listen(process.env.PORT || 5004, () => console.log(`Payment Service on port ${process.env.PORT || 5004}`));
