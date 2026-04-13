require('dotenv').config({ path: require('path').join(__dirname, '.env') });
const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const errorResponse = require('../shared/utils/errorResponse');
const parseUser = require('../shared/middleware/parseUser');
const platformGuard = require('../shared/middleware/platformGuard');
const bus = require('../shared/eventBus');
const path = require('path');
const multer = require('multer');
const { v4: uuidv4 } = require('uuid');
const imageService = require('./services/imageService');
const fs = require('fs');

const app = express();
app.use(express.json());
app.use(cors());
app.use(parseUser);
app.use(platformGuard);

const db = mongoose.createConnection(process.env.MONGODB_URI);
db.on('connected', () => console.log('Shipping DB Connected'));
db.on('error', (err) => console.error('[SHIPPING] DB error:', err.message));

// ── Status constants (B) ────────────────────────────────────────────────────

const CARRIER_STATUSES      = ['created', 'in_transit', 'out_for_delivery', 'delivered'];
const SELF_FULFILL_STATUSES = ['created', 'preparing', 'in_transit', 'delivered'];
const PICKUP_STATUSES       = ['created', 'preparing', 'ready_for_pickup', 'picked_up'];
const ALL_STATUSES          = [...new Set([
    ...CARRIER_STATUSES,
    ...SELF_FULFILL_STATUSES,
    ...PICKUP_STATUSES,
    'cancelled'
])];
const VALID_STATUSES = CARRIER_STATUSES; // backward compat alias

const CARRIER_TRACKING_URLS = {
    UPS:   'https://www.ups.com/track?tracknum=',
    USPS:  'https://tools.usps.com/go/TrackConfirmAction?tLabels=',
    FedEx: 'https://www.fedex.com/fedextrack/?trknbr='
};

function getStatusArray(fulfillmentType) {
    switch (fulfillmentType) {
        case 'self_fulfilled': return SELF_FULFILL_STATUSES;
        case 'pickup':       return PICKUP_STATUSES;
        default:             return CARRIER_STATUSES;
    }
}

const EST_DELIVERY_BOUNDS = {
    shipping:      { minDays: 1, maxDays: 14 },
    self_fulfilled: { minDays: 0, maxDays: 7 },
    pickup:         { minDays: 0, maxDays: 7 }
};

// ── Schemas (S1) ─────────────────────────────────────────────────────────────

const TimelineEntrySchema = new mongoose.Schema({
    status:    { type: String, enum: ALL_STATUSES, required: true },
    note:      String,
    proofUrl:  String,
    location:  String,
    timestamp: { type: Date, default: Date.now }
}, { _id: false });

const ShipmentItemSchema = new mongoose.Schema({
    orderItemId: { type: mongoose.Schema.Types.ObjectId },
    title:       String,
    qty:         { type: Number, default: 1 }
}, { _id: false });

const EscalationHistoryEntrySchema = new mongoose.Schema({
    tier:      Number,
    reason:    String,
    timestamp: { type: Date, default: Date.now }
}, { _id: false });

const ShipmentSchema = new mongoose.Schema({
    orderId:           { type: mongoose.Schema.Types.ObjectId, required: true },
    sellerId:          { type: mongoose.Schema.Types.ObjectId, required: true },
    buyerId:           { type: mongoose.Schema.Types.ObjectId },
    carrier:           String,
    trackingNumber:    String,
    fulfillmentType:   { type: String, enum: ['shipping', 'self_fulfilled', 'pickup'], default: 'shipping' },
    status:            { type: String, enum: ALL_STATUSES, default: 'created' },
    timeline:          { type: [TimelineEntrySchema], default: [] },
    items:             { type: [ShipmentItemSchema],  default: [] },
    estimatedDelivery: Date,
    deliveredAt:       Date,
    buyerConfirmedAt:  Date,
    deliveryProof: {
        url:        String,
        uploadedAt: Date,
        uploadedBy: String
    },
    escalationTier:          { type: Number, default: 0 },
    escalationHistory:       { type: [EscalationHistoryEntrySchema], default: [] },
    sellerResponseDeadline:  Date,
    delayFlaggedAt:          Date,
    sellerNotes:       String,
    updatedAt:         { type: Date, default: Date.now }
});

ShipmentSchema.index({ orderId: 1 });
ShipmentSchema.index({ sellerId: 1, updatedAt: -1 });
ShipmentSchema.index({ status: 1, updatedAt: -1 });

const Shipment = db.model('Shipment', ShipmentSchema);

// ── Static serving + multer config (D) ──────────────────────────────────────

const uploadsDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });
app.use('/uploads', express.static(uploadsDir));

const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 8 * 1024 * 1024 }  // 8 MB
});

// ── Event listeners ────────────────────────────────────────────────────────────

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

function detectCarrier(trackingNumber) {
    if (!trackingNumber) return null;
    const t = trackingNumber.trim();
    if (/^1Z[A-Z0-9]{16}$/i.test(t))                  return 'UPS';
    if (/^(94|92|93|47|82|03)\d{16,20}$/.test(t))     return 'USPS';
    if (/^\d{12,15}$/.test(t))                         return 'FedEx';
    return null;
}

// ── Routes ────────────────────────────────────────────────────────────────────

// POST / — Create shipment (S1, S3, E)
app.post('/', async (req, res) => {
    if (!req.user || !req.user.storeId) return errorResponse(res, 401, 'Unauthorized');
    if (req.user.storeId !== req.body.sellerId?.toString()) {
        return errorResponse(res, 403, 'storeId claim mismatch');
    }
    try {
        const fulfillmentType = req.body.fulfillmentType || 'shipping';
        if (!['shipping', 'self_fulfilled', 'pickup'].includes(fulfillmentType)) {
            return errorResponse(res, 400, 'Invalid fulfillmentType. Must be shipping, self_fulfilled, or pickup');
        }

        // Validate per mode
        if (fulfillmentType === 'shipping' && !req.body.trackingNumber) {
            return errorResponse(res, 400, 'trackingNumber is required for carrier fulfillment');
        }
        if (fulfillmentType === 'pickup' && !req.body.estimatedDelivery) {
            return errorResponse(res, 400, 'estimatedDelivery (pickup-ready date) is required for pickup fulfillment');
        }

        // Best-effort: fetch buyerId from order-service
        let buyerId = null;
        try {
            const orderRes = await fetch(`${process.env.ORDER_SERVICE_URL || 'http://localhost:5003'}/${req.body.orderId}`);
            if (orderRes.ok) { const order = await orderRes.json(); buyerId = order.buyerId || null; }
        } catch (_) { /* fail open */ }

        // Carrier auto-detect if not explicitly provided (C1)
        const carrier = req.body.carrier || detectCarrier(req.body.trackingNumber) || undefined;

        const timelineEntries = [{ status: 'created', timestamp: new Date() }];

        // Auto-advance carrier shipments to in_transit on creation
        if (fulfillmentType === 'shipping' && req.body.trackingNumber) {
            timelineEntries.push({ status: 'in_transit', timestamp: new Date() });
        }

        const initialStatus = fulfillmentType === 'shipping' && req.body.trackingNumber
            ? 'in_transit'
            : 'created';

        const shipment = await Shipment.create({
            ...req.body,
            fulfillmentType,
            carrier,
            buyerId,
            status:   initialStatus,
            items:    Array.isArray(req.body.items) ? req.body.items : [],
            timeline: timelineEntries
        });

        bus.emit('shipment.created', {
            orderId:         shipment.orderId,
            sellerId:        shipment.sellerId,
            buyerId:         shipment.buyerId,
            carrier:         shipment.carrier        || null,
            trackingNumber:  shipment.trackingNumber || null,
            fulfillmentType: shipment.fulfillmentType
        });
        console.log(`[SHIPPING] Shipment created for order ${shipment.orderId} (${fulfillmentType})`);
        res.status(201).json(shipment);
    } catch (err) { errorResponse(res, 500, err.message); }
});

// GET /seller/stats — Seller delivery statistics (C6)
app.get('/seller/stats', async (req, res) => {
    if (!req.user || !req.user.storeId) return errorResponse(res, 401, 'Unauthorized');
    try {
        const sellerId = req.user.storeId;
        const shipments = await Shipment.find({ sellerId }).lean();

        const delivered  = shipments.filter(s => ['delivered', 'picked_up'].includes(s.status));
        const inTransit  = shipments.filter(s => ['in_transit', 'out_for_delivery', 'preparing', 'ready_for_pickup'].includes(s.status));
        const cancelled  = shipments.filter(s => s.status === 'cancelled');

        const timed = delivered.filter(s => s.estimatedDelivery && s.deliveredAt);
        const onTime = timed.filter(s => new Date(s.deliveredAt) <= new Date(s.estimatedDelivery));
        const onTimeRate = timed.length ? Math.round((onTime.length / timed.length) * 100) / 100 : null;

        const withTiming = delivered.filter(s => s.deliveredAt && s.timeline?.length);
        const avgDaysToShip = withTiming.length
            ? Math.round((withTiming.reduce((sum, s) => {
                const start = s.timeline[0]?.timestamp || s.updatedAt;
                return sum + (new Date(s.deliveredAt) - new Date(start));
              }, 0) / withTiming.length) / 86400000 * 10) / 10
            : null;

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

// GET /admin/escalated — Admin view of escalated shipments, sorted by tier (I)
app.get('/admin/escalated', async (req, res) => {
    if (!req.user || req.user.role !== 'admin') return errorResponse(res, 403, 'Admin only');
    try {
        const { page = 1, limit = 50 } = req.query;
        const query = { escalationTier: { $gte: 1 } };

        const skip  = (parseInt(page) - 1) * parseInt(limit);
        const total = await Shipment.countDocuments(query);
        const shipments = await Shipment.find(query)
            .sort({ escalationTier: -1, updatedAt: 1 })
            .skip(skip)
            .limit(parseInt(limit));

        res.json({ shipments, total, page: parseInt(page), hasMore: skip + shipments.length < total });
    } catch (err) { errorResponse(res, 500, err.message); }
});

// POST /upload-proof — Upload delivery/pickup proof photo (G)
// MUST be before parameterized routes
app.post('/upload-proof', upload.single('proof'), async (req, res) => {
    if (!req.user || !req.user.storeId) return errorResponse(res, 401, 'Unauthorized');
    if (!req.file) return errorResponse(res, 400, 'No file uploaded');
    if (!req.body.shipmentId) return errorResponse(res, 400, 'shipmentId is required');
    try {
        const shipment = await Shipment.findById(req.body.shipmentId);
        if (!shipment) return errorResponse(res, 404, 'Shipment not found');
        if (shipment.sellerId.toString() !== req.user.storeId) {
            return errorResponse(res, 403, 'Not owned by you');
        }

        // Compress to 50KB
        const compressed = await imageService.compress(req.file.buffer, 50);
        const filename = `${uuidv4()}.jpg`;
        const filePath = path.join(uploadsDir, filename);
        fs.writeFileSync(filePath, compressed);

        const proofUrl = `/uploads/${filename}`;
        const timestamp = new Date();

        shipment.deliveryProof = {
            url:        proofUrl,
            uploadedAt: timestamp,
            uploadedBy: req.user.sub || req.user.storeId
        };
        shipment.updatedAt = timestamp;
        await shipment.save();

        bus.emit('shipment.proof_uploaded', {
            orderId:    shipment.orderId,
            sellerId:   shipment.sellerId,
            buyerId:    shipment.buyerId || null,
            shipmentId: shipment._id,
            proofUrl
        });

        console.log(`[SHIPPING] Proof uploaded for shipment ${shipment._id}`);
        res.json({ proofUrl, shipmentId: shipment._id });
    } catch (err) { errorResponse(res, 500, err.message); }
});

// GET /order/:orderId — Buyer or seller tracking, auth-scoped (R6, J)
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

        // Enrich response
        const response = shipments.map(s => {
            const enriched = (isSeller || isAdmin) ? { ...s } : (() => {
                const { sellerNotes: _sn, ...rest } = s;
                return rest;
            })();

            // Add carrierTrackingUrl
            if (s.carrier && s.trackingNumber && CARRIER_TRACKING_URLS[s.carrier]) {
                enriched.carrierTrackingUrl = CARRIER_TRACKING_URLS[s.carrier] + encodeURIComponent(s.trackingNumber);
            }

            // Conditionally include deliveryProof (only for delivered/picked_up or admin)
            if (s.deliveryProof?.url && (['delivered', 'picked_up'].includes(s.status) || isAdmin)) {
                enriched.deliveryProof = s.deliveryProof;
            } else if (!isAdmin && !['delivered', 'picked_up'].includes(s.status)) {
                delete enriched.deliveryProof;
            }

            return enriched;
        });

        res.json(response);
    } catch (err) { errorResponse(res, 500, err.message); }
});

// POST /order/:orderId/confirm-delivery — Buyer confirms receipt (C7, L)
app.post('/order/:orderId/confirm-delivery', async (req, res) => {
    if (!req.user?.sub) return errorResponse(res, 401, 'Unauthorized');
    try {
        const baseQuery = { orderId: req.params.orderId };
        if (req.query.shipmentId) baseQuery._id = req.query.shipmentId;

        const shipment = req.query.shipmentId
            ? await Shipment.findOne(baseQuery)
            : await Shipment.findOne({ orderId: req.params.orderId, status: { $in: ['delivered', 'picked_up'] } })
                            .sort({ updatedAt: -1 });

        if (!shipment) return errorResponse(res, 404, 'Shipment not found');
        if (shipment.buyerId?.toString() !== req.user.sub) return errorResponse(res, 403, 'Not your order');
        if (shipment.buyerConfirmedAt)                     return errorResponse(res, 400, 'Already confirmed');
        if (!['delivered', 'picked_up'].includes(shipment.status)) {
            return errorResponse(res, 400, 'Shipment not yet delivered or picked up');
        }

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

// POST /:id/seller-response — Seller responds to escalation (H)
app.post('/:id/seller-response', async (req, res) => {
    if (!req.user || !req.user.storeId) return errorResponse(res, 401, 'Unauthorized');
    try {
        const shipment = await Shipment.findById(req.params.id);
        if (!shipment) return errorResponse(res, 404, 'Shipment not found');
        if (shipment.sellerId.toString() !== req.user.storeId) {
            return errorResponse(res, 403, 'Not owned by you');
        }
        if (shipment.escalationTier < 1) {
            return errorResponse(res, 400, 'Shipment is not escalated');
        }

        const { note, newEstimatedDelivery } = req.body;
        if (!note || typeof note !== 'string' || !note.trim()) {
            return errorResponse(res, 400, 'note is required');
        }

        const timestamp = new Date();
        shipment.timeline.push({
            status: shipment.status,
            note: `Seller response: ${note.trim()}`,
            timestamp
        });

        if (newEstimatedDelivery) {
            const newDate = new Date(newEstimatedDelivery);
            if (isNaN(newDate.getTime())) {
                return errorResponse(res, 400, 'Invalid newEstimatedDelivery date');
            }
            shipment.estimatedDelivery = newDate;
        }

        // Reset escalation tier back to 0 and extend seller response deadline
        shipment.escalationTier = 0;
        shipment.sellerResponseDeadline = null;
        shipment.updatedAt = timestamp;
        await shipment.save();

        bus.emit('shipment.seller_responded', {
            orderId:    shipment.orderId,
            sellerId:   shipment.sellerId,
            buyerId:    shipment.buyerId || null,
            shipmentId: shipment._id,
            note:       note.trim()
        });

        console.log(`[SHIPPING] Seller responded to escalation on shipment ${shipment._id}`);
        res.json(shipment);
    } catch (err) { errorResponse(res, 500, err.message); }
});

// PATCH /:id/status — Structured status update, type-aware forward-only (S2, S3, F)
app.patch('/:id/status', async (req, res) => {
    const { status, note, location } = req.body;
    try {
        const shipment = await Shipment.findById(req.params.id);
        if (!shipment) return errorResponse(res, 404, 'Shipment not found');
        if (!req.user || shipment.sellerId.toString() !== req.user.storeId) {
            return errorResponse(res, 403, 'Not owned by you');
        }
        if (shipment.status === 'cancelled') {
            return errorResponse(res, 400, 'Cannot update a cancelled shipment');
        }

        // Get the correct status progression for this fulfillment type
        const statusArray = getStatusArray(shipment.fulfillmentType);
        if (!statusArray.includes(status)) {
            return errorResponse(res, 400, `Invalid status '${status}' for ${shipment.fulfillmentType}. Must be one of: ${statusArray.join(', ')}`);
        }

        // Forward-only progression
        const currentIdx = statusArray.indexOf(shipment.status);
        const newIdx     = statusArray.indexOf(status);
        if (newIdx <= currentIdx) {
            return errorResponse(res, 400, `Cannot go backwards from '${shipment.status}' to '${status}'`);
        }

        // Proof guard: self_fulfilled and pickup require proof before final status
        const finalStatuses = { self_fulfilled: 'delivered', pickup: 'picked_up' };
        const requiresProof = finalStatuses[shipment.fulfillmentType];
        if (requiresProof && status === requiresProof && !shipment.deliveryProof?.url) {
            return errorResponse(res, 400, `Delivery proof is required before marking as '${status}'. Upload proof first via POST /upload-proof`);
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

        if (status === 'delivered' || status === 'picked_up') {
            shipment.deliveredAt = timestamp;
            const onTime = shipment.estimatedDelivery
                ? (timestamp <= new Date(shipment.estimatedDelivery))
                : null;
            await shipment.save();

            bus.emit('shipment.delivered', {
                orderId:           shipment.orderId,
                sellerId:          shipment.sellerId,
                buyerId:           shipment.buyerId        || null,
                carrier:           shipment.carrier        || null,
                trackingNumber:    shipment.trackingNumber || null,
                fulfillmentType:   shipment.fulfillmentType,
                createdAt:         shipment.timeline[0]?.timestamp || null,
                deliveredAt:       timestamp,
                estimatedDelivery: shipment.estimatedDelivery || null,
                onTime,
                itemCount:         shipment.items.length,
                items:             shipment.items
            });

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

// ── Background jobs (K) ─────────────────────────────────────────────────────

const TWO_HOURS  = 2 * 60 * 60 * 1000;
const SIX_HOURS  = 6 * 60 * 60 * 1000;
const ONE_DAY    = 24 * 60 * 60 * 1000;
const TWO_DAYS   = 48 * 60 * 60 * 1000;

// K1: Escalation sweep (every 2h)
// tier 0 -> 1 -> 2 -> 3 based on overdue estimated delivery
// Auto-cancel at tier 3 + 48h with no seller response
setInterval(async () => {
    try {
        const now = new Date();
        // Find shipments past estimated delivery that are not yet delivered/cancelled/picked_up
        const overdue = await Shipment.find({
            status: { $nin: ['delivered', 'picked_up', 'cancelled'] },
            estimatedDelivery: { $lt: now }
        });

        for (const shipment of overdue) {
            const hoursPastDue = (now - new Date(shipment.estimatedDelivery)) / (60 * 60 * 1000);
            let newTier = shipment.escalationTier;

            if (hoursPastDue >= 72 && newTier < 3) newTier = 3;
            else if (hoursPastDue >= 48 && newTier < 2) newTier = 2;
            else if (hoursPastDue >= 24 && newTier < 1) newTier = 1;

            // Auto-cancel: tier 3 and sellerResponseDeadline passed (48h after tier 3)
            if (shipment.escalationTier >= 3 && shipment.sellerResponseDeadline && now > new Date(shipment.sellerResponseDeadline)) {
                shipment.status = 'cancelled';
                shipment.timeline.push({ status: 'cancelled', note: 'Auto-cancelled: escalation tier 3 with no seller response', timestamp: now });
                shipment.updatedAt = now;
                await shipment.save();
                bus.emit('shipment.auto_cancelled', {
                    orderId:    shipment.orderId,
                    sellerId:   shipment.sellerId,
                    buyerId:    shipment.buyerId || null,
                    shipmentId: shipment._id,
                    reason:     'escalation_timeout'
                });
                bus.emit('shipment.status_updated', {
                    orderId:  shipment.orderId,
                    sellerId: shipment.sellerId,
                    buyerId:  shipment.buyerId || null,
                    status:   'cancelled',
                    note:     'Auto-cancelled: escalation tier 3 with no seller response',
                    location: null,
                    timestamp: now
                });
                console.log(`[SHIPPING] Auto-cancelled shipment ${shipment._id} (escalation timeout)`);
                continue;
            }

            if (newTier > shipment.escalationTier) {
                shipment.escalationTier = newTier;
                shipment.escalationHistory.push({ tier: newTier, reason: `Auto-escalated: ${hoursPastDue.toFixed(0)}h past estimated delivery`, timestamp: now });
                if (newTier === 3) {
                    shipment.sellerResponseDeadline = new Date(now.getTime() + TWO_DAYS);
                }
                shipment.delayFlaggedAt = shipment.delayFlaggedAt || now;
                shipment.updatedAt = now;
                await shipment.save();
                bus.emit('shipment.escalated', {
                    orderId:    shipment.orderId,
                    sellerId:   shipment.sellerId,
                    buyerId:    shipment.buyerId || null,
                    shipmentId: shipment._id,
                    tier:       newTier
                });
                console.log(`[SHIPPING] Escalated shipment ${shipment._id} to tier ${newTier}`);
            }
        }
    } catch (err) { console.error('[SHIPPING] Escalation sweep error:', err.message); }
}, TWO_HOURS);

// K2: Buyer confirmation sweep (every 2h)
// Auto-confirm carrier shipments 48h after delivery
// Nudge self_fulfill/pickup buyers
setInterval(async () => {
    try {
        const now = new Date();
        const cutoff = new Date(now.getTime() - TWO_DAYS);

        // Auto-confirm carrier shipments delivered >48h ago with no buyer confirmation
        const carrierAutoConfirm = await Shipment.find({
            fulfillmentType: 'shipping',
            status: 'delivered',
            deliveredAt: { $lt: cutoff },
            buyerConfirmedAt: null
        });

        for (const shipment of carrierAutoConfirm) {
            shipment.buyerConfirmedAt = now;
            shipment.updatedAt = now;
            await shipment.save();
            bus.emit('shipment.buyer_confirmed', {
                orderId:    shipment.orderId,
                sellerId:   shipment.sellerId,
                buyerId:    shipment.buyerId,
                shipmentId: shipment._id,
                autoConfirmed: true
            });
            console.log(`[SHIPPING] Auto-confirmed carrier shipment ${shipment._id}`);
        }

        // Nudge self_fulfilled/pickup buyers who haven't confirmed after 48h
        const needsNudge = await Shipment.find({
            fulfillmentType: { $in: ['self_fulfilled', 'pickup'] },
            status: { $in: ['delivered', 'picked_up'] },
            deliveredAt: { $lt: cutoff },
            buyerConfirmedAt: null
        });

        for (const shipment of needsNudge) {
            bus.emit('shipment.confirmation_nudge', {
                orderId:    shipment.orderId,
                sellerId:   shipment.sellerId,
                buyerId:    shipment.buyerId || null,
                shipmentId: shipment._id,
                fulfillmentType: shipment.fulfillmentType
            });
        }
        if (needsNudge.length) {
            console.log(`[SHIPPING] Buyer confirmation nudge: ${needsNudge.length} shipment(s)`);
        }
    } catch (err) { console.error('[SHIPPING] Buyer confirmation sweep error:', err.message); }
}, TWO_HOURS);

// K3: Pickup no-show sweep (every 6h)
// Day 3: nudge buyer, Day 5: flag seller, Day 7: auto-cancel
setInterval(async () => {
    try {
        const now = new Date();
        const pickupReady = await Shipment.find({
            fulfillmentType: 'pickup',
            status: 'ready_for_pickup'
        });

        for (const shipment of pickupReady) {
            const readyEntry = shipment.timeline.find(t => t.status === 'ready_for_pickup');
            if (!readyEntry) continue;
            const daysSinceReady = (now - new Date(readyEntry.timestamp)) / ONE_DAY;

            if (daysSinceReady >= 7) {
                // Auto-cancel
                shipment.status = 'cancelled';
                shipment.timeline.push({ status: 'cancelled', note: 'Auto-cancelled: pickup no-show after 7 days', timestamp: now });
                shipment.updatedAt = now;
                await shipment.save();
                bus.emit('shipment.auto_cancelled', {
                    orderId:    shipment.orderId,
                    sellerId:   shipment.sellerId,
                    buyerId:    shipment.buyerId || null,
                    shipmentId: shipment._id,
                    reason:     'pickup_no_show'
                });
                bus.emit('shipment.status_updated', {
                    orderId:  shipment.orderId,
                    sellerId: shipment.sellerId,
                    buyerId:  shipment.buyerId || null,
                    status:   'cancelled',
                    note:     'Auto-cancelled: pickup no-show after 7 days',
                    location: null,
                    timestamp: now
                });
                console.log(`[SHIPPING] Auto-cancelled pickup shipment ${shipment._id} (no-show 7d)`);
            } else if (daysSinceReady >= 5) {
                bus.emit('shipment.pickup_noshow_flag', {
                    orderId:    shipment.orderId,
                    sellerId:   shipment.sellerId,
                    buyerId:    shipment.buyerId || null,
                    shipmentId: shipment._id,
                    daysSinceReady: Math.floor(daysSinceReady)
                });
            } else if (daysSinceReady >= 3) {
                bus.emit('shipment.pickup_nudge', {
                    orderId:    shipment.orderId,
                    sellerId:   shipment.sellerId,
                    buyerId:    shipment.buyerId || null,
                    shipmentId: shipment._id,
                    daysSinceReady: Math.floor(daysSinceReady)
                });
            }
        }
    } catch (err) { console.error('[SHIPPING] Pickup no-show sweep error:', err.message); }
}, SIX_HOURS);

// K4: Dead order detection (every 6h)
// Shipments stuck in 'created' for >7 days -> auto-cancel
setInterval(async () => {
    try {
        const now = new Date();
        const cutoff = new Date(now.getTime() - 7 * ONE_DAY);
        const dead = await Shipment.find({
            status: 'created',
            updatedAt: { $lt: cutoff }
        });

        for (const shipment of dead) {
            shipment.status = 'cancelled';
            shipment.timeline.push({ status: 'cancelled', note: 'Auto-cancelled: no activity for 7+ days', timestamp: now });
            shipment.updatedAt = now;
            await shipment.save();
            bus.emit('shipment.auto_cancelled', {
                orderId:    shipment.orderId,
                sellerId:   shipment.sellerId,
                buyerId:    shipment.buyerId || null,
                shipmentId: shipment._id,
                reason:     'dead_order'
            });
            bus.emit('shipment.status_updated', {
                orderId:  shipment.orderId,
                sellerId: shipment.sellerId,
                buyerId:  shipment.buyerId || null,
                status:   'cancelled',
                note:     'Auto-cancelled: no activity for 7+ days',
                location: null,
                timestamp: now
            });
            console.log(`[SHIPPING] Auto-cancelled dead shipment ${shipment._id} (>7d in created)`);
        }
        if (dead.length) {
            console.log(`[SHIPPING] Dead order sweep: ${dead.length} shipment(s) cancelled`);
        }
    } catch (err) { console.error('[SHIPPING] Dead order sweep error:', err.message); }
}, SIX_HOURS);

// ── ADMIN ROUTES ──────────────────────────────────────────────────────────────

// GET /admin/unshipped — shipments in 'created' status for > 24h
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
        if ((status === 'delivered' || status === 'picked_up') && !shipment.deliveredAt) {
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

// POST /admin/:id/resolve-dispute — Admin resolves escalated dispute (Phase 5)
app.post('/admin/:id/resolve-dispute', async (req, res) => {
    if (!req.user || req.user.role !== 'admin') return errorResponse(res, 403, 'Admin only');
    const { decision, adminNote, refundAmount } = req.body;
    if (!['buyer_correct', 'seller_correct', 'split'].includes(decision)) {
        return errorResponse(res, 400, 'decision must be buyer_correct, seller_correct, or split');
    }
    if (!adminNote || typeof adminNote !== 'string' || !adminNote.trim()) {
        return errorResponse(res, 400, 'adminNote is required');
    }
    try {
        const shipment = await Shipment.findById(req.params.id);
        if (!shipment) return errorResponse(res, 404, 'Shipment not found');

        const timestamp = new Date();
        shipment.timeline.push({
            status: shipment.status,
            note: `Admin resolution (${decision}): ${adminNote.trim()}`,
            timestamp
        });
        shipment.escalationTier = 0;
        shipment.sellerResponseDeadline = null;
        shipment.updatedAt = timestamp;
        await shipment.save();

        bus.emit('shipment.dispute_resolved', {
            orderId:      shipment.orderId,
            sellerId:     shipment.sellerId,
            buyerId:      shipment.buyerId    || null,
            shipmentId:   shipment._id,
            decision,
            adminNote:    adminNote.trim(),
            refundAmount: refundAmount        || null
        });

        console.log(`[SHIPPING] Admin resolved dispute on shipment ${shipment._id} — decision: ${decision}`);
        res.json({ resolved: true, shipmentId: shipment._id, decision });
    } catch (err) { errorResponse(res, 500, err.message); }
});

app.get('/health', (req, res) => {
    res.json({ service: 'shipping-service', status: 'ok', dbState: db.readyState === 1 ? 'connected' : 'disconnected' });
});

app.listen(process.env.PORT || 5007, () => console.log(`Shipping Service on port ${process.env.PORT || 5007}`));
