require('dotenv').config({ path: require('path').join(__dirname, '.env') });
const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const errorResponse = require('../shared/utils/errorResponse');
const parseUser = require('../shared/middleware/parseUser');
const platformGuard = require('../shared/middleware/platformGuard');
const bus = require('../shared/eventBus');

const app = express();
app.use(express.json());
app.use(cors());
app.use(parseUser);
app.use(platformGuard);

const db = mongoose.createConnection(process.env.MONGODB_URI);
db.on('connected', () => console.log('Shipping DB Connected'));
db.on('error', (err) => console.error('[SHIPPING] DB error:', err.message));

const VALID_STATUSES = ['created', 'in_transit', 'out_for_delivery', 'delivered'];
const ALL_STATUSES   = [...VALID_STATUSES, 'cancelled'];

// ── Schemas (S1) ─────────────────────────────────────────────────────────────

const TimelineEntrySchema = new mongoose.Schema({
    status:    { type: String, enum: ALL_STATUSES, required: true },
    note:      String,
    location:  String,
    timestamp: { type: Date, default: Date.now }
}, { _id: false });

const ShipmentItemSchema = new mongoose.Schema({
    orderItemId: { type: mongoose.Schema.Types.ObjectId },
    title:       String,
    qty:         { type: Number, default: 1 }
}, { _id: false });

const ShipmentSchema = new mongoose.Schema({
    orderId:           { type: mongoose.Schema.Types.ObjectId, required: true },
    sellerId:          { type: mongoose.Schema.Types.ObjectId, required: true },
    buyerId:           { type: mongoose.Schema.Types.ObjectId },
    carrier:           String,
    trackingNumber:    String,
    status:            { type: String, enum: ALL_STATUSES, default: 'created' },
    timeline:          { type: [TimelineEntrySchema], default: [] },
    items:             { type: [ShipmentItemSchema],  default: [] },
    estimatedDelivery: Date,
    deliveredAt:       Date,
    buyerConfirmedAt:  Date,
    sellerNotes:       String,   // internal only — not exposed in buyer-facing responses
    updatedAt:         { type: Date, default: Date.now }
});

ShipmentSchema.index({ orderId: 1 });
ShipmentSchema.index({ sellerId: 1, updatedAt: -1 });
ShipmentSchema.index({ status: 1, updatedAt: -1 });

const Shipment = db.model('Shipment', ShipmentSchema);

// ── Event listeners ────────────────────────────────────────────────────────────

// Two-phase delete: order-service emits this after anonymizing buyer orders.
// We delete shipments for those specific orders rather than listening to user.deleted directly —
// this eliminates the race where shipping-service might act before order-service finishes.
bus.on('user.orders_anonymized', async (payload) => {
    try {
        const { userId, orderIds } = payload;
        if (!orderIds?.length) return;
        const objectIds = orderIds.map(id => new mongoose.Types.ObjectId(id));
        const result = await Shipment.deleteMany({ orderId: { $in: objectIds } });
        console.log(`[SHIPPING] Deleted ${result.deletedCount} shipment(s) for anonymized orders of user ${userId}`);
    } catch (err) { console.error('[SHIPPING] user.orders_anonymized cleanup error:', err.message); }
});

// ── Carrier auto-detection (C1) ───────────────────────────────────────────────
// Heuristic only — seller-provided carrier always wins if supplied.
function detectCarrier(trackingNumber) {
    if (!trackingNumber) return null;
    const t = trackingNumber.trim();
    if (/^1Z[A-Z0-9]{16}$/i.test(t))                  return 'UPS';
    if (/^(94|92|93|47|82|03)\d{16,20}$/.test(t))     return 'USPS';
    if (/^\d{12,15}$/.test(t))                         return 'FedEx';
    return null;
}

// ── Routes ────────────────────────────────────────────────────────────────────
// Route order: specific named paths before parameterised ones.

// POST / — Create shipment (S1, S3)
app.post('/', async (req, res) => {
    if (!req.user || !req.user.storeId) return errorResponse(res, 401, 'Unauthorized');
    if (req.user.storeId !== req.body.sellerId?.toString()) {
        return errorResponse(res, 403, 'storeId claim mismatch');
    }
    try {
        // Best-effort: fetch buyerId from order-service to store on the shipment
        let buyerId = null;
        try {
            const orderRes = await fetch(`${process.env.ORDER_SERVICE_URL || 'http://localhost:5003'}/${req.body.orderId}`);
            if (orderRes.ok) { const order = await orderRes.json(); buyerId = order.buyerId || null; }
        } catch (_) { /* fail open */ }

        // Carrier auto-detect if not explicitly provided (C1)
        const carrier = req.body.carrier || detectCarrier(req.body.trackingNumber) || undefined;

        const shipment = await Shipment.create({
            ...req.body,
            carrier,
            buyerId,
            items:    Array.isArray(req.body.items) ? req.body.items : [],
            timeline: [{ status: 'created', timestamp: new Date() }]
        });

        // shipment.created covers the 'created' state in messaging — do NOT also emit
        // shipment.status_updated for 'created' (would duplicate the system message). (C4 note)
        bus.emit('shipment.created', {
            orderId:        shipment.orderId,
            sellerId:       shipment.sellerId,
            buyerId:        shipment.buyerId,
            carrier:        shipment.carrier        || null,
            trackingNumber: shipment.trackingNumber || null
        });
        console.log(`[SHIPPING] Shipment created for order ${shipment.orderId}`);
        res.status(201).json(shipment);
    } catch (err) { errorResponse(res, 500, err.message); }
});

// GET /seller/stats — Seller delivery statistics (C6) — must precede GET /seller
app.get('/seller/stats', async (req, res) => {
    if (!req.user || !req.user.storeId) return errorResponse(res, 401, 'Unauthorized');
    try {
        const sellerId = req.user.storeId;
        const shipments = await Shipment.find({ sellerId }).lean();

        const delivered  = shipments.filter(s => s.status === 'delivered');
        const inTransit  = shipments.filter(s => ['in_transit','out_for_delivery'].includes(s.status));
        const cancelled  = shipments.filter(s => s.status === 'cancelled');

        // On-time rate — only shipments that had estimatedDelivery set
        const timed = delivered.filter(s => s.estimatedDelivery && s.deliveredAt);
        const onTime = timed.filter(s => new Date(s.deliveredAt) <= new Date(s.estimatedDelivery));
        const onTimeRate = timed.length ? Math.round((onTime.length / timed.length) * 100) / 100 : null;

        // Avg days from creation (timeline[0].timestamp) to deliveredAt
        const withTiming = delivered.filter(s => s.deliveredAt && s.timeline?.length);
        const avgDaysToShip = withTiming.length
            ? Math.round((withTiming.reduce((sum, s) => {
                const start = s.timeline[0]?.timestamp || s.updatedAt;
                return sum + (new Date(s.deliveredAt) - new Date(start));
              }, 0) / withTiming.length) / 86400000 * 10) / 10
            : null;

        // Carrier breakdown
        const carrierBreakdown = {};
        shipments.forEach(s => {
            if (s.carrier) carrierBreakdown[s.carrier] = (carrierBreakdown[s.carrier] || 0) + 1;
        });

        res.json({
            totalShipments: shipments.length,
            delivered:      delivered.length,
            inTransit:      inTransit.length,
            cancelled:      cancelled.length,
            onTimeRate,
            avgDaysToShip,
            carrierBreakdown
        });
    } catch (err) { errorResponse(res, 500, err.message); }
});

// GET /seller — Seller's shipments, paginated + filtered (S5)
app.get('/seller', async (req, res) => {
    if (!req.user || !req.user.storeId) return errorResponse(res, 401, 'Unauthorized');
    try {
        const { status, page = 1, limit = 20 } = req.query;
        const query = { sellerId: req.user.storeId };
        if (status && ALL_STATUSES.includes(status)) query.status = status;

        const skip  = (parseInt(page) - 1) * parseInt(limit);
        const total = await Shipment.countDocuments(query);
        const shipments = await Shipment.find(query)
            .sort({ updatedAt: -1 })
            .skip(skip)
            .limit(parseInt(limit));

        res.json({
            shipments,
            total,
            page:    parseInt(page),
            hasMore: skip + shipments.length < total
        });
    } catch (err) { errorResponse(res, 500, err.message); }
});

// GET /admin — Admin-only full shipment list (R10)
app.get('/admin', async (req, res) => {
    if (!req.user || req.user.role !== 'admin') return errorResponse(res, 403, 'Admin only');
    try {
        const { orderId, status, carrier, page = 1, limit = 50 } = req.query;
        const query = {};
        if (orderId) query.orderId = orderId;
        if (status && ALL_STATUSES.includes(status)) query.status = status;
        if (carrier) query.carrier = new RegExp(carrier, 'i');

        const skip  = (parseInt(page) - 1) * parseInt(limit);
        const total = await Shipment.countDocuments(query);
        const shipments = await Shipment.find(query)
            .sort({ updatedAt: -1 })
            .skip(skip)
            .limit(parseInt(limit));

        res.json({ shipments, total, page: parseInt(page), hasMore: skip + shipments.length < total });
    } catch (err) { errorResponse(res, 500, err.message); }
});

// GET /order/:orderId — Buyer or seller tracking, auth-scoped (R6)
app.get('/order/:orderId', async (req, res) => {
    if (!req.user) return errorResponse(res, 401, 'Unauthorized');
    try {
        const shipments = await Shipment.find({ orderId: req.params.orderId }).lean();
        if (!shipments.length) return res.json([]);

        const userId  = req.user.sub;
        const storeId = req.user.storeId;
        const isAdmin = req.user.role === 'admin';

        const isBuyer  = shipments.some(s => s.buyerId?.toString()  === userId);
        const isSeller = shipments.some(s => s.sellerId?.toString() === storeId);

        if (!isAdmin && !isBuyer && !isSeller) return errorResponse(res, 403, 'Access denied');

        // Strip sellerNotes from buyer-facing response
        const response = (isSeller || isAdmin)
            ? shipments
            : shipments.map(({ sellerNotes: _sn, ...rest }) => rest);

        res.json(response);
    } catch (err) { errorResponse(res, 500, err.message); }
});

// POST /order/:orderId/confirm-delivery — Buyer confirms receipt (C7)
// Optional ?shipmentId= to target a specific shipment; falls back to most recent delivered.
app.post('/order/:orderId/confirm-delivery', async (req, res) => {
    if (!req.user?.sub) return errorResponse(res, 401, 'Unauthorized');
    try {
        const baseQuery = { orderId: req.params.orderId };
        if (req.query.shipmentId) baseQuery._id = req.query.shipmentId;

        const shipment = req.query.shipmentId
            ? await Shipment.findOne(baseQuery)
            : await Shipment.findOne({ orderId: req.params.orderId, status: 'delivered' })
                            .sort({ updatedAt: -1 });

        if (!shipment) return errorResponse(res, 404, 'Shipment not found');
        if (shipment.buyerId?.toString() !== req.user.sub) return errorResponse(res, 403, 'Not your order');
        if (shipment.buyerConfirmedAt)                     return errorResponse(res, 400, 'Already confirmed');
        if (shipment.status !== 'delivered')               return errorResponse(res, 400, 'Shipment not yet delivered');

        shipment.buyerConfirmedAt = new Date();
        shipment.updatedAt        = new Date();
        await shipment.save();

        bus.emit('shipment.buyer_confirmed', {
            orderId:    shipment.orderId,
            sellerId:   shipment.sellerId,
            buyerId:    shipment.buyerId,
            shipmentId: shipment._id
        });
        res.json({ confirmed: true, shipmentId: shipment._id });
    } catch (err) { errorResponse(res, 500, err.message); }
});

// PATCH /:id/status — Structured carrier webhook, forward-only (S2, S3)
app.patch('/:id/status', async (req, res) => {
    const { status, note, location } = req.body;
    if (!VALID_STATUSES.includes(status)) {
        return errorResponse(res, 400, `Invalid status. Must be one of: ${VALID_STATUSES.join(', ')}`);
    }
    try {
        const shipment = await Shipment.findById(req.params.id);
        if (!shipment) return errorResponse(res, 404, 'Shipment not found');
        if (!req.user || shipment.sellerId.toString() !== req.user.storeId) {
            return errorResponse(res, 403, 'Not owned by you');
        }
        if (shipment.status === 'cancelled') {
            return errorResponse(res, 400, 'Cannot update a cancelled shipment');
        }

        // Forward-only progression
        const currentIdx = VALID_STATUSES.indexOf(shipment.status);
        const newIdx     = VALID_STATUSES.indexOf(status);
        if (newIdx <= currentIdx) {
            return errorResponse(res, 400, `Cannot go backwards from '${shipment.status}' to '${status}'`);
        }

        const timestamp = new Date();
        shipment.timeline.push({ status, note: note || undefined, location: location || undefined, timestamp });
        shipment.status    = status;
        shipment.updatedAt = timestamp;

        // Auto-detect carrier from trackingNumber if still unset (C1)
        if (!shipment.carrier && shipment.trackingNumber) {
            const detected = detectCarrier(shipment.trackingNumber);
            if (detected) shipment.carrier = detected;
        }

        if (status === 'delivered') {
            shipment.deliveredAt = timestamp;
            // Compute onTime: true if delivered on or before estimated; null if no estimate set
            const onTime = shipment.estimatedDelivery
                ? (timestamp <= new Date(shipment.estimatedDelivery))
                : null;
            await shipment.save();

            // Enriched delivered payload (R8)
            bus.emit('shipment.delivered', {
                orderId:           shipment.orderId,
                sellerId:          shipment.sellerId,
                buyerId:           shipment.buyerId        || null,
                carrier:           shipment.carrier        || null,
                trackingNumber:    shipment.trackingNumber || null,
                createdAt:         shipment.timeline[0]?.timestamp || null,
                deliveredAt:       timestamp,
                estimatedDelivery: shipment.estimatedDelivery || null,
                onTime,
                itemCount:         shipment.items.length,
                items:             shipment.items
            });

            // Late delivery signal (C2)
            if (onTime === false) {
                const daysLate = Math.round(
                    (timestamp - new Date(shipment.estimatedDelivery)) / 86400000 * 10
                ) / 10;
                bus.emit('shipment.late', {
                    orderId:  shipment.orderId,
                    sellerId: shipment.sellerId,
                    daysLate,
                    carrier:  shipment.carrier || null
                });
            }
        } else {
            await shipment.save();

            if (status === 'out_for_delivery') {
                bus.emit('shipment.out_for_delivery', {
                    orderId:           shipment.orderId,
                    buyerId:           shipment.buyerId           || null,
                    carrier:           shipment.carrier           || null,
                    trackingNumber:    shipment.trackingNumber    || null,
                    estimatedDelivery: shipment.estimatedDelivery || null
                });
            }
        }

        // Every non-'created' status push emits status_updated for messaging-service thread injection (C4)
        // 'created' is excluded — shipment.created already covers it to avoid duplicate system messages.
        bus.emit('shipment.status_updated', {
            orderId:        shipment.orderId,
            sellerId:       shipment.sellerId,
            buyerId:        shipment.buyerId || null,
            status,
            note:           note     || null,
            location:       location || null,
            timestamp
        });

        res.json(shipment);
    } catch (err) { errorResponse(res, 500, err.message); }
});

// PATCH /:id/cancel — Cancel shipment (valid only when still in 'created' state) (R7, S4)
app.patch('/:id/cancel', async (req, res) => {
    try {
        const shipment = await Shipment.findById(req.params.id);
        if (!shipment) return errorResponse(res, 404, 'Shipment not found');
        if (!req.user || shipment.sellerId.toString() !== req.user.storeId) {
            return errorResponse(res, 403, 'Not owned by you');
        }

        const lastStatus = shipment.timeline[shipment.timeline.length - 1]?.status || shipment.status;
        if (lastStatus !== 'created') {
            return errorResponse(res, 400, `Cannot cancel: shipment is already '${lastStatus}'. Cancellation is only allowed before the carrier has it.`);
        }

        const timestamp = new Date();
        const { note } = req.body;
        shipment.timeline.push({ status: 'cancelled', note: note || undefined, timestamp });
        shipment.status    = 'cancelled';
        shipment.updatedAt = timestamp;
        await shipment.save();

        bus.emit('shipment.cancelled', {
            orderId:    shipment.orderId,
            sellerId:   shipment.sellerId,
            buyerId:    shipment.buyerId || null,
            shipmentId: shipment._id
        });
        // Emit status_updated so messaging-service can inject "Shipment cancelled" system message (C4)
        bus.emit('shipment.status_updated', {
            orderId:   shipment.orderId,
            sellerId:  shipment.sellerId,
            buyerId:   shipment.buyerId || null,
            status:    'cancelled',
            note:      note || null,
            location:  null,
            timestamp
        });

        res.json(shipment);
    } catch (err) { errorResponse(res, 500, err.message); }
});

// ── Ship-by reminder sweep (C5) ───────────────────────────────────────────────
// Every 6h: find shipments stuck in 'created' for > 48h and nudge the seller.
// Implemented within shipping-service's own data — queries stalled shipments
// (created but never advanced) rather than querying order-service for processing orders.
const OVERDUE_MS      = 48 * 60 * 60 * 1000;
const SWEEP_INTERVAL  =  6 * 60 * 60 * 1000;

setInterval(async () => {
    try {
        const cutoff  = new Date(Date.now() - OVERDUE_MS);
        const stalled = await Shipment.find(
            { status: 'created', updatedAt: { $lt: cutoff } },
            { orderId: 1, sellerId: 1 }
        ).lean();

        for (const s of stalled) {
            bus.emit('shipment.overdue', {
                orderId:    s.orderId,
                sellerId:   s.sellerId,
                shipmentId: s._id
            });
        }
        if (stalled.length) {
            console.log(`[SHIPPING] Overdue sweep: ${stalled.length} stalled shipment(s) flagged`);
        }
    } catch (err) { console.error('[SHIPPING] Overdue sweep error:', err.message); }
}, SWEEP_INTERVAL);

// ── ADMIN ROUTES ──────────────────────────────────────────────────────────────

// GET /admin/unshipped — shipments in 'created' status for > 24h (paid but not yet shipped)
// Query params: page=1, limit=50
app.get('/admin/unshipped', async (req, res) => {
    if (!req.user || req.user.role !== 'admin') return errorResponse(res, 403, 'Admin only');
    try {
        const { page = 1, limit = 50 } = req.query;
        const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000);
        const query  = { status: 'created', updatedAt: { $lt: cutoff } };

        const skip  = (parseInt(page) - 1) * parseInt(limit);
        const total = await Shipment.countDocuments(query);
        const shipments = await Shipment.find(query)
            .sort({ updatedAt: 1 })
            .skip(skip)
            .limit(parseInt(limit));

        res.json({ shipments, total, page: parseInt(page) });
    } catch (err) { errorResponse(res, 500, err.message); }
});

// GET /admin/stuck-in-transit — shipments in 'in_transit' for > 10 days
app.get('/admin/stuck-in-transit', async (req, res) => {
    if (!req.user || req.user.role !== 'admin') return errorResponse(res, 403, 'Admin only');
    try {
        const { page = 1, limit = 50 } = req.query;
        const cutoff = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000);
        const query  = { status: 'in_transit', updatedAt: { $lt: cutoff } };

        const skip  = (parseInt(page) - 1) * parseInt(limit);
        const total = await Shipment.countDocuments(query);
        const shipments = await Shipment.find(query)
            .sort({ updatedAt: 1 })
            .skip(skip)
            .limit(parseInt(limit));

        res.json({ shipments, total, page: parseInt(page) });
    } catch (err) { errorResponse(res, 500, err.message); }
});

// PATCH /admin/:id/force-status — force any shipment to any valid status
// Body: { status, reason }
app.patch('/admin/:id/force-status', async (req, res) => {
    if (!req.user || req.user.role !== 'admin') return errorResponse(res, 403, 'Admin only');
    const { status, reason } = req.body;
    if (!status || !ALL_STATUSES.includes(status)) {
        return errorResponse(res, 400, `status must be one of: ${ALL_STATUSES.join(', ')}`);
    }
    try {
        const shipment = await Shipment.findById(req.params.id);
        if (!shipment) return errorResponse(res, 404, 'Shipment not found');

        const timestamp = new Date();
        shipment.timeline.push({ status, note: reason || 'Admin force-status', timestamp });
        shipment.status    = status;
        shipment.updatedAt = timestamp;
        if (status === 'delivered' && !shipment.deliveredAt) {
            shipment.deliveredAt = timestamp;
        }
        await shipment.save();

        bus.emit('shipment.status_updated', {
            orderId:   shipment.orderId,
            sellerId:  shipment.sellerId,
            buyerId:   shipment.buyerId || null,
            status,
            note:      reason || null,
            location:  null,
            timestamp,
            adminAction: true
        });

        res.json(shipment);
    } catch (err) { errorResponse(res, 500, err.message); }
});

// PATCH /admin/:id/mark-delivered — force mark shipment as delivered
// Body: { reason }
app.patch('/admin/:id/mark-delivered', async (req, res) => {
    if (!req.user || req.user.role !== 'admin') return errorResponse(res, 403, 'Admin only');
    try {
        const shipment = await Shipment.findById(req.params.id);
        if (!shipment) return errorResponse(res, 404, 'Shipment not found');

        const timestamp = new Date();
        shipment.timeline.push({ status: 'delivered', note: req.body.reason || 'Admin mark-delivered', timestamp });
        shipment.status      = 'delivered';
        shipment.deliveredAt = timestamp;
        shipment.updatedAt   = timestamp;
        await shipment.save();

        bus.emit('order.delivered', {
            orderId:     shipment.orderId,
            shipmentId:  shipment._id,
            adminAction: true
        });

        res.json(shipment);
    } catch (err) { errorResponse(res, 500, err.message); }
});

// POST /admin/:id/note — attach internal admin note to a shipment
// Body: { note }
// Appends to adminNotes array: { note, addedAt, addedBy }
app.post('/admin/:id/note', async (req, res) => {
    if (!req.user || req.user.role !== 'admin') return errorResponse(res, 403, 'Admin only');
    const { note } = req.body;
    if (!note || typeof note !== 'string' || !note.trim()) {
        return errorResponse(res, 400, 'note is required');
    }
    try {
        const entry = {
            note:    note.trim(),
            addedAt: new Date(),
            addedBy: req.user?.email || req.user?.sub || 'admin'
        };
        const shipment = await Shipment.findByIdAndUpdate(
            req.params.id,
            { $push: { adminNotes: entry }, $set: { updatedAt: new Date() } },
            { new: true }
        );
        if (!shipment) return errorResponse(res, 404, 'Shipment not found');
        res.json({ shipmentId: shipment._id, adminNotes: shipment.adminNotes });
    } catch (err) { errorResponse(res, 500, err.message); }
});

app.get('/health', (req, res) => {
    res.json({ service: 'shipping-service', status: 'ok', dbState: db.readyState === 1 ? 'connected' : 'disconnected' });
});

app.listen(process.env.PORT || 5007, () => console.log(`Shipping Service on port ${process.env.PORT || 5007}`));
