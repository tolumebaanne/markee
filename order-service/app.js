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
db.on('connected', () => console.log('Order DB Connected'));
db.on('error', (err) => console.error('[ORDER] DB error:', err.message));

app.get('/health', (req, res) => {
    res.json({ service: 'order-service', status: 'ok', dbState: db.readyState === 1 ? 'connected' : 'disconnected' });
});

const OrderSchema = new mongoose.Schema({
    buyerId:  { type: mongoose.Schema.Types.ObjectId, required: true },
    items: [{
        productId: mongoose.Schema.Types.ObjectId,
        sellerId:  mongoose.Schema.Types.ObjectId,
        title:     String,
        image:     String,
        qty:       Number,
        price:     Number
    }],
    status: {
        type:    String,
        enum:    ['pending', 'paid', 'processing', 'shipped', 'delivered', 'cancelled',
                  'ready_for_pickup', 'picked_up', 'self_fulfilled'],
        default: 'pending'
    },
    fulfillmentType: {
        type:    String,
        enum:    ['shipping', 'pickup', 'self_fulfilled'],
        default: 'shipping'
    },
    // Canonical address fields: street, city, province, postalCode, country, label, isDefault
    shippingAddress: { street: String, city: String, province: String, postalCode: String, country: String },
    billingAddress:  { street: String, city: String, province: String, postalCode: String, country: String },
    deliverySpeed:   { type: String, enum: ['standard', 'fast'], default: 'standard' },
    deliveryFee:     { type: Number, default: 0 },
    cancellationReason: { type: String, default: '' },
    // S3/C-O3 — Structured cancellation category for analytics
    cancellationCategory: {
        type: String,
        enum: ['buyer_request', 'seller_request', 'inventory_failure', 'payment_failure',
               'cod_rejection', 'reservation_expired', 'admin_action', 'system'],
        default: null
    },
    timeline:   [{ status: String, timestamp: Date }],
    totalAmount: Number,
    paymentMethod: { type: String, enum: ['escrow', 'cod'], default: 'escrow' },
    // S3/R-O1 — Order notes: buyer note visible to seller; seller note hidden from buyer
    buyerNote:  { type: String, default: '', maxLength: 500 },
    sellerNote: { type: String, default: '', maxLength: 500 },
    // Fulfillment detail fields — populated at order creation based on fulfillmentType
    selectedCarrier: {
        type:    String,
        enum:    ['canada_post', 'ups', 'fedex', 'purolator', 'dhl', 'other'],
        default: null
    },
    pickupLocationId: { type: String, default: null },
    selfFulfillmentAddress: {
        street:     { type: String, default: '' },
        city:       { type: String, default: '' },
        province:   { type: String, default: '' },
        postalCode: { type: String, default: '' },
        country:    { type: String, default: 'Canada' }
    },
    selfFulfillmentInstructions: { type: String, default: '', maxLength: 500 },
    createdAt:  { type: Date, default: Date.now, index: true }
});
const Order = db.model('Order', OrderSchema);

// ── State machine ─────────────────────────────────────────────────────────────
const MANUAL_TRANSITIONS = {
    pending:          ['cancelled'],
    paid:             ['processing', 'cancelled'],
    processing:       [],
    shipped:          [],
    delivered:        [],
    cancelled:        [],
    ready_for_pickup: [],
    picked_up:        [],
    self_fulfilled:   []
};

const SYSTEM_TRANSITIONS = {
    pending:    'paid',
    paid:       'shipped',
    processing: 'shipped',
    shipped:    'delivered'
};

async function advanceStatus(orderId, newStatus, extra = {}) {
    const order = await Order.findByIdAndUpdate(
        orderId,
        { status: newStatus, $push: { timeline: { status: newStatus, timestamp: new Date() } }, ...extra },
        { new: true }
    );
    if (order) {
        const payload = {
            orderId:   order._id,
            status:    newStatus,
            buyerId:   order.buyerId,
            sellerIds: [...new Set(order.items.map(i => i.sellerId?.toString()).filter(Boolean))]
        };
        if (newStatus === 'cancelled') payload.items = order.items;
        bus.emit('order.status_updated', payload);
        console.log(`[ORDER] ${orderId} → ${newStatus}`);
    }
    return order;
}

// ── Event listeners ──────────────────────────────────────────────────────────

bus.on('payment.captured', async (payload) => {
    try {
        const order = await Order.findById(payload.orderId);
        if (!order || order.status !== 'pending') return;
        await advanceStatus(payload.orderId, 'paid');
    } catch (err) { console.error('[ORDER] payment.captured error:', err.message); }
});

bus.on('shipment.created', async (payload) => {
    try {
        const order = await Order.findById(payload.orderId);
        if (!order) return;
        if (['paid', 'processing'].includes(order.status)) {
            await advanceStatus(payload.orderId, 'shipped');
        }
    } catch (err) { console.error('[ORDER] shipment.created error:', err.message); }
});

bus.on('shipment.delivered', async (payload) => {
    try {
        const order = await Order.findById(payload.orderId);
        if (!order || order.status !== 'shipped') return;
        await advanceStatus(payload.orderId, 'delivered');
    } catch (err) { console.error('[ORDER] shipment.delivered error:', err.message); }
});

bus.on('shipment.cancelled', async (payload) => {
    try {
        const order = await Order.findById(payload.orderId);
        if (!order || order.status !== 'shipped') return;
        await advanceStatus(payload.orderId, 'processing');
        console.log(`[ORDER] Reverted order ${payload.orderId} to processing after shipment cancellation`);
    } catch (err) { console.error('[ORDER] shipment.cancelled error:', err.message); }
});

// Shipping auto-cancellation (e.g. carrier rejected, label expired)
bus.on('shipment.auto_cancelled', async (payload) => {
    try {
        const order = await Order.findById(payload.orderId);
        if (!order || order.status === 'cancelled') return;
        order.status              = 'cancelled';
        order.cancellationReason  = payload.reason || 'Shipment auto-cancelled by system';
        order.cancellationCategory = 'system';
        order.timeline.push({ status: 'cancelled', timestamp: new Date() });
        await order.save();
        bus.emit('order.status_updated', {
            orderId:   order._id,
            status:    'cancelled',
            buyerId:   order.buyerId,
            sellerIds: [...new Set(order.items.map(i => i.sellerId?.toString()).filter(Boolean))],
            items:     order.items
        });
        console.log(`[ORDER] ${payload.orderId} → cancelled (shipment.auto_cancelled)`);
    } catch (err) { console.error('[ORDER] shipment.auto_cancelled error:', err.message); }
});

// Buyer no-show for pickup
bus.on('shipment.pickup_noshow', async (payload) => {
    try {
        const order = await Order.findById(payload.orderId);
        if (!order || order.status === 'cancelled') return;
        order.status              = 'cancelled';
        order.cancellationReason  = 'buyer_pickup_noshow';
        order.cancellationCategory = 'system';
        order.timeline.push({ status: 'cancelled', timestamp: new Date() });
        await order.save();
        bus.emit('order.status_updated', {
            orderId:   order._id,
            status:    'cancelled',
            buyerId:   order.buyerId,
            sellerIds: [...new Set(order.items.map(i => i.sellerId?.toString()).filter(Boolean))],
            items:     order.items
        });
        console.log(`[ORDER] ${payload.orderId} → cancelled (shipment.pickup_noshow)`);
    } catch (err) { console.error('[ORDER] shipment.pickup_noshow error:', err.message); }
});

bus.on('order.inventory_failed', async (payload) => {
    try {
        const order = await Order.findById(payload.orderId);
        if (!order || order.status !== 'pending') return;
        await advanceStatus(payload.orderId, 'cancelled', {
            cancellationReason:   payload.reason || 'One or more items were out of stock.',
            cancellationCategory: 'inventory_failure'
        });
        console.log(`[ORDER] Cancelled order ${payload.orderId} — inventory failed`);
    } catch (err) { console.error('[ORDER] order.inventory_failed error:', err.message); }
});

// S17 — Reservation expired: cancel abandoned pending orders (same path as inventory_failed)
bus.on('order.reservation_expired', async (payload) => {
    try {
        const order = await Order.findById(payload.orderId);
        if (!order || order.status !== 'pending') return;
        await advanceStatus(payload.orderId, 'cancelled', {
            cancellationReason:   'Order reservation expired — payment was not completed in time.',
            cancellationCategory: 'reservation_expired'
        });
        console.log(`[ORDER] Cancelled order ${payload.orderId} — reservation expired`);
    } catch (err) { console.error('[ORDER] order.reservation_expired error:', err.message); }
});

bus.on('payment.pending', async (payload) => {
    console.log(`[ORDER] COD order ${payload.orderId} acknowledged — awaiting seller acceptance`);
});

bus.on('payment.collected', async (payload) => {
    try {
        const order = await Order.findById(payload.orderId);
        if (!order) return;
        if (['shipped', 'processing', 'pending', 'paid'].includes(order.status)) {
            await advanceStatus(payload.orderId, 'delivered');
        }
    } catch (err) { console.error('[ORDER] payment.collected error:', err.message); }
});

bus.on('payment.refunded', async (payload) => {
    try {
        const order = await Order.findById(payload.orderId);
        if (!order || order.status === 'cancelled') return;
        await advanceStatus(payload.orderId, 'cancelled', {
            cancellationReason:   `Refund: ${payload.reason || 'Admin issued refund'}`,
            cancellationCategory: 'payment_failure'
        });
    } catch (err) { console.error('[ORDER] payment.refunded error:', err.message); }
});

bus.on('payment.cod_rejected', async (payload) => {
    try {
        const order = await Order.findById(payload.orderId);
        if (!order || order.status === 'cancelled') return;
        await advanceStatus(payload.orderId, 'cancelled', {
            cancellationReason:   `COD not available: ${payload.reason || 'buyer_score_too_low'}`,
            cancellationCategory: 'cod_rejection'
        });
    } catch (err) { console.error('[ORDER] payment.cod_rejected error:', err.message); }
});

// Anonymize buyer orders on hard-delete — orders are business records and must be preserved.
// After anonymizing, emit user.orders_anonymized so shipping-service knows which shipments to purge.
bus.on('user.deleted', async (payload) => {
    try {
        const uid = payload.userId;
        const SENTINEL = new mongoose.Types.ObjectId('000000000000000000000000');

        const orders = await Order.find({ buyerId: uid }).select('_id');
        const orderIds = orders.map(o => o._id.toString());

        if (orderIds.length) {
            await Order.updateMany(
                { buyerId: uid },
                {
                    $set: {
                        buyerId:          SENTINEL,
                        shippingAddress:  {},
                        billingAddress:   {},
                        buyerNote:        ''
                    }
                }
            );
            console.log(`[ORDER] Anonymized ${orderIds.length} orders for deleted user ${uid}`);
        }

        // Two-phase signal: shipping-service listens to this, not user.deleted
        bus.emit('user.orders_anonymized', { userId: uid, orderIds });
    } catch (err) { console.error('[ORDER] user.deleted anonymization error:', err.message); }
});

// ── Routes ───────────────────────────────────────────────────────────────────

// Internal: check if a store has open seller orders — used by auth-service before allowing self-deletion
// and by admin proxy before allowing hard-delete. No auth required (internal service-to-service call).
app.get('/seller-orders-check', async (req, res) => {
    try {
        const { storeId } = req.query;
        if (!storeId) return errorResponse(res, 400, 'storeId required');
        const count = await Order.countDocuments({
            'items.sellerId': new mongoose.Types.ObjectId(storeId),
            status: { $in: ['pending', 'paid', 'processing', 'shipped', 'ready_for_pickup'] }
        });
        res.json({ hasOpen: count > 0, count });
    } catch (err) { errorResponse(res, 500, err.message); }
});

// S23 — Admin order list — declared BEFORE /:id to avoid param capture
app.get('/admin/orders', async (req, res) => {
    if (req.user?.role !== 'admin') return errorResponse(res, 403, 'Admin only');
    try {
        const { status, buyerId, sellerId, from, to, paymentMethod, page = 1, limit = 50 } = req.query;
        const query = {};
        if (status)        query.status = status;
        if (paymentMethod) query.paymentMethod = paymentMethod;
        if (buyerId)       query.buyerId = buyerId;
        if (sellerId)      query['items.sellerId'] = new mongoose.Types.ObjectId(sellerId);
        if (from || to)    query.createdAt = { ...(from && { $gte: new Date(from) }), ...(to && { $lte: new Date(to) }) };
        const skip  = (parseInt(page) - 1) * parseInt(limit);
        const lim   = Math.min(parseInt(limit), 100);
        const total = await Order.countDocuments(query);
        const orders = await Order.find(query).sort({ createdAt: -1 }).skip(skip).limit(lim);
        res.json({ orders, total, page: parseInt(page), hasMore: skip + lim < total });
    } catch (err) { errorResponse(res, 500, err.message); }
});

// GET /admin/orders/:id — single order detail for admin
app.get('/admin/orders/:id', async (req, res) => {
    try {
        const order = await Order.findById(req.params.id);
        if (!order) return errorResponse(res, 404, 'Order not found');
        res.json(order);
    } catch (err) { errorResponse(res, 500, err.message); }
});

// POST /admin/orders/:id/cancel — admin cancel order
app.post('/admin/orders/:id/cancel', async (req, res) => {
    try {
        const { reason } = req.body;
        const order = await Order.findByIdAndUpdate(
            req.params.id,
            { status: 'cancelled', cancelledAt: new Date(), cancelReason: reason || 'admin_action' },
            { new: true }
        );
        if (!order) return errorResponse(res, 404, 'Order not found');
        bus.emit('order.cancelled', { orderId: order._id, reason: reason || 'admin_action', adminAction: true });
        res.json(order);
    } catch (err) { errorResponse(res, 500, err.message); }
});

// DELETE /admin/orders/:id — superuser hard-delete
app.delete('/admin/orders/:id', async (req, res) => {
    if (!req.headers['x-admin-email']) return errorResponse(res, 403, 'Admin only');
    try {
        const order = await Order.findByIdAndDelete(req.params.id);
        if (!order) return errorResponse(res, 404, 'Order not found');
        bus.emit('order.deleted', { orderId: order._id, adminEmail: req.headers['x-admin-email'] });
        res.json({ message: 'Order deleted', orderId: order._id });
    } catch (err) { errorResponse(res, 500, err.message); }
});

// POST /admin/orders/:id/status — admin force any status
app.post('/admin/orders/:id/status', async (req, res) => {
    try {
        const { status, reason } = req.body;
        if (!status) return errorResponse(res, 400, 'status required');
        const order = await Order.findByIdAndUpdate(
            req.params.id,
            { status, updatedAt: new Date() },
            { new: true }
        );
        if (!order) return errorResponse(res, 404, 'Order not found');
        bus.emit('order.status_changed', { orderId: order._id, status, reason: reason || 'admin_force', adminAction: true });
        res.json(order);
    } catch (err) { errorResponse(res, 500, err.message); }
});

app.post('/', async (req, res) => {
    try {
        // Block order placement for users who have initiated account deletion
        if (req.user?.pendingDeletion) {
            return errorResponse(res, 403, 'Account deletion is pending. New orders cannot be placed during the 24-hour cancellation window.');
        }

        const { items, shippingAddress, billingAddress, deliverySpeed, deliveryFee, totalAmount } = req.body;
        if (!items || !items.length) return errorResponse(res, 400, 'Order must have at least one item');

        // S24 — Price validation: reject if any item differs from catalog price by > 5%
        for (const item of items) {
            try {
                const controller = new AbortController();
                setTimeout(() => controller.abort(), 2500);
                const r = await fetch(`http://localhost:5002/products/${item.productId}`, { signal: controller.signal });
                if (r.ok) {
                    const prod = await r.json();
                    if (prod.price !== undefined && item.price !== undefined) {
                        const diff = Math.abs(item.price - prod.price) / prod.price;
                        if (diff > 0.05) {
                            return errorResponse(res, 400, `Price mismatch for "${item.title || item.productId}". Current: ${prod.price}, submitted: ${item.price}. Please refresh and try again.`);
                        }
                    }
                }
            } catch { /* fail open — catalog unreachable */ }
        }

        const { fulfillmentType, paymentMethod, selectedCarrier, selfFulfillmentAddress, selfFulfillmentInstructions, pickupLocationId } = req.body;
        const sellerIds = [...new Set(items.map(i => i.sellerId?.toString()).filter(Boolean))];

        // S29 — Vacation mode check: block order if any seller is on vacation
        for (const sid of sellerIds) {
            try {
                const controller = new AbortController();
                setTimeout(() => controller.abort(), 2000);
                const r = await fetch(`http://localhost:5005/by-seller/${sid}`, { signal: controller.signal });
                if (r.ok) {
                    const store = await r.json();
                    if (store.vacationMode?.active) {
                        const resume = store.vacationMode.resumesAt
                            ? ` Expected return: ${new Date(store.vacationMode.resumesAt).toLocaleDateString()}.`
                            : '';
                        return errorResponse(res, 400, `"${store.name || 'A seller'}" is currently on vacation.${resume} ${store.vacationMode.message || ''}`);
                    }
                }
            } catch { /* fail open — seller service unreachable */ }
        }

        const resolvedFulfillmentType = (
            (fulfillmentType === 'pickup' || fulfillmentType === 'self_fulfilled') && sellerIds.length === 1
        ) ? fulfillmentType : 'shipping';

        // B2b — Carrier: validate against enum; null if absent or invalid
        const VALID_CARRIERS = ['canada_post', 'ups', 'fedex', 'purolator', 'dhl', 'other'];
        const resolvedCarrier = (resolvedFulfillmentType === 'shipping' && VALID_CARRIERS.includes(selectedCarrier))
            ? selectedCarrier
            : null;

        // Address validation — shippingAddress required for shipping/self_fulfilled; not required for pickup (stored as pickup location)
        if (resolvedFulfillmentType !== 'pickup') {
            if (!shippingAddress?.street?.trim())     return errorResponse(res, 400, 'shippingAddress.street is required');
            if (!shippingAddress?.city?.trim())       return errorResponse(res, 400, 'shippingAddress.city is required');
            if (!shippingAddress?.postalCode?.trim()) return errorResponse(res, 400, 'shippingAddress.postalCode is required');
        }

        // Sanitize shippingAddress and billingAddress to canonical fields only
        const sanitizeAddr = (a) => a ? {
            street:     String(a.street     || '').trim().slice(0, 200),
            city:       String(a.city       || '').trim().slice(0, 100),
            province:   String(a.province   || '').trim().slice(0, 100),
            postalCode: String(a.postalCode || '').trim().slice(0, 20),
            country:    String(a.country    || 'Canada').trim().slice(0, 100),
        } : undefined;

        const resolvedShippingAddress = sanitizeAddr(shippingAddress);
        const resolvedBillingAddress  = sanitizeAddr(billingAddress || shippingAddress);

        // B2c — Self-fulfil address: sanitize each field; only store when fulfillmentType is self_fulfilled
        const resolvedSFAddress = resolvedFulfillmentType === 'self_fulfilled' && selfFulfillmentAddress
            ? {
                street:     String(selfFulfillmentAddress.street     || '').trim().slice(0, 200),
                city:       String(selfFulfillmentAddress.city       || '').trim().slice(0, 100),
                province:   String(selfFulfillmentAddress.province   || '').trim().slice(0, 100),
                postalCode: String(selfFulfillmentAddress.postalCode || '').trim().slice(0, 20),
                country:    String(selfFulfillmentAddress.country    || 'Canada').trim().slice(0, 100),
            }
            : undefined;

        // B2d — Self-fulfil instructions: strip < to prevent HTML injection, trim, cap at 500
        const resolvedSFInstructions = resolvedFulfillmentType === 'self_fulfilled'
            ? String(selfFulfillmentInstructions || '').replace(/</g, '&lt;').trim().slice(0, 500)
            : '';

        const order = await Order.create({
            buyerId: req.user?.sub || req.body.buyerId,
            items,
            fulfillmentType: resolvedFulfillmentType,
            shippingAddress:  resolvedShippingAddress,
            billingAddress:   resolvedBillingAddress,
            deliverySpeed:   deliverySpeed   || 'standard',
            deliveryFee:     deliveryFee     || 0,
            totalAmount,
            paymentMethod:               paymentMethod   || 'escrow',
            buyerNote:                   (req.body.buyerNote || '').slice(0, 500),
            selectedCarrier:             resolvedCarrier,
            pickupLocationId:            resolvedFulfillmentType === 'pickup' ? (pickupLocationId || null) : null,
            selfFulfillmentAddress:      resolvedSFAddress,
            selfFulfillmentInstructions: resolvedSFInstructions,
            status:   'pending',
            timeline: [{ status: 'pending', timestamp: new Date() }]
        });

        bus.emit('order.placed', {
            orderId:       order._id,
            buyerId:       order.buyerId,
            sellerIds:     [...new Set(order.items.map(i => i.sellerId?.toString()).filter(Boolean))],
            items:         order.items,
            totalAmount:   order.totalAmount,
            paymentMethod: order.paymentMethod
        });
        res.status(201).json(order);
    } catch (err) { errorResponse(res, 500, err.message); }
});

// Buyer order history
app.get('/my-orders', async (req, res) => {
    try {
        const buyerId = req.user?.sub;
        if (!buyerId) return errorResponse(res, 401, 'Unauthorized');
        const orders = await Order.find({ buyerId }).sort({ createdAt: -1 });
        // Strip sellerNote from buyer view
        res.json(orders.map(o => { const d = o.toObject(); delete d.sellerNote; return d; }));
    } catch (err) { errorResponse(res, 500, err.message); }
});

// S20 — Fix seller-stats: include pickup/self_fulfilled/ready_for_pickup statuses
app.get('/seller-stats', async (req, res) => {
    try {
        const sellerId = req.user?.storeId;
        if (!sellerId) return errorResponse(res, 400, 'User is not a seller');
        const sellerOid = new mongoose.Types.ObjectId(sellerId);
        const orders = await Order.find({ 'items.sellerId': sellerOid });
        const activeOrders = orders.filter(o =>
            ['pending', 'paid', 'processing', 'shipped', 'ready_for_pickup'].includes(o.status)
        ).length;
        const completedStatuses = ['delivered', 'picked_up', 'self_fulfilled', 'ready_for_pickup'];
        let revenue = 0;
        orders.forEach(o => {
            if (completedStatuses.includes(o.status)) {
                o.items.forEach(i => {
                    if (i.sellerId?.toString() === sellerId.toString()) revenue += i.price * i.qty;
                });
            }
        });
        res.json({ activeOrders, revenueCents: revenue, totalOrders: orders.length });
    } catch (err) { errorResponse(res, 500, err.message); }
});

// Seller's orders
app.get('/seller-orders', async (req, res) => {
    try {
        const sellerId = req.user?.storeId;
        if (!sellerId) return errorResponse(res, 400, 'User is not a seller');
        let sellerOid;
        try { sellerOid = new mongoose.Types.ObjectId(sellerId); }
        catch { return errorResponse(res, 400, 'Invalid storeId in token'); }
        const orders = await Order.find({ 'items.sellerId': sellerOid }).sort({ createdAt: -1 });
        // Seller sees both notes; buyer note visible, seller note included
        res.json(orders.map(o => ({
            ...o.toObject(),
            items: o.items.filter(i => i.sellerId?.toString() === sellerId.toString())
        })));
    } catch (err) { errorResponse(res, 500, err.message); }
});

// S19 — Order notes: role-branched PATCH
app.patch('/:id/note', async (req, res) => {
    try {
        const order = await Order.findById(req.params.id);
        if (!order) return errorResponse(res, 404, 'Order not found');
        const userId  = req.user?.sub;
        const storeId = req.user?.storeId;
        const isBuyer  = order.buyerId.toString() === userId;
        const isSeller = storeId && order.items.some(i => i.sellerId?.toString() === storeId);
        if (!isBuyer && !isSeller) return errorResponse(res, 403, 'Access denied');

        const { note } = req.body;
        if (note === undefined) return errorResponse(res, 400, 'note field required');

        if (isBuyer) {
            // Buyer can only set buyerNote while pending and within 15-minute window
            if (order.status !== 'pending') return errorResponse(res, 400, 'Buyer note can only be set while order is pending');
            if (Date.now() - new Date(order.createdAt).getTime() > 15 * 60 * 1000) {
                return errorResponse(res, 400, 'Note editing window has passed (15 minutes from order creation)');
            }
            order.buyerNote = note.slice(0, 500);
        } else {
            // Seller can set sellerNote at any time
            order.sellerNote = note.slice(0, 500);
        }

        await order.save();
        const resp = order.toObject();
        if (isBuyer) delete resp.sellerNote;
        res.json(resp);
    } catch (err) { errorResponse(res, 500, err.message); }
});

// S21 — Repeat order: returns a draft pre-filled from original, does NOT auto-submit
app.post('/:id/repeat', async (req, res) => {
    try {
        const order = await Order.findById(req.params.id);
        if (!order) return errorResponse(res, 404, 'Order not found');
        if (order.buyerId.toString() !== req.user?.sub) return errorResponse(res, 403, 'Not your order');

        const priceChanges    = [];
        const unavailableItems = [];
        const enrichedItems   = [];

        await Promise.all(order.items.map(async (item) => {
            let currentPrice    = item.price;
            let available       = null;

            // Best-effort current price from catalog
            try {
                const controller = new AbortController();
                setTimeout(() => controller.abort(), 2500);
                const r = await fetch(`http://localhost:5002/products/${item.productId}`, { signal: controller.signal });
                if (r.ok) { const p = await r.json(); currentPrice = p.price; }
            } catch { /* fail open */ }

            // Best-effort availability from inventory
            try {
                const controller = new AbortController();
                setTimeout(() => controller.abort(), 2500);
                const r = await fetch(`http://localhost:5006/stock/${item.productId}`, { signal: controller.signal });
                if (r.ok) { const s = await r.json(); available = s.available; }
            } catch { /* fail open */ }

            if (available !== null && available < item.qty) {
                unavailableItems.push(item.productId);
            }
            if (currentPrice !== item.price) {
                priceChanges.push({ productId: item.productId, originalPrice: item.price, currentPrice });
            }
            enrichedItems.push({ ...item.toObject(), currentPrice, currentAvailability: available });
        }));

        const totalAmount = enrichedItems.reduce((sum, i) => sum + (i.currentPrice * i.qty), 0);
        res.json({ items: enrichedItems, totalAmount, priceChanges, unavailableItems });
    } catch (err) { errorResponse(res, 500, err.message); }
});

// S22 — Order modification window: buyer can modify items within 15 minutes of placing
app.patch('/:id/items', async (req, res) => {
    try {
        const order = await Order.findById(req.params.id);
        if (!order) return errorResponse(res, 404, 'Order not found');
        if (order.buyerId.toString() !== req.user?.sub) return errorResponse(res, 403, 'Not your order');
        if (order.status !== 'pending') return errorResponse(res, 400, 'Can only modify pending orders');
        if (Date.now() - new Date(order.createdAt).getTime() > 15 * 60 * 1000) {
            return errorResponse(res, 400, 'Modification window has closed (15 minutes from order creation)');
        }

        const { addItems = [], removeItems = [] } = req.body;

        // Remove items: restore reserved stock, remove from order
        for (const productId of removeItems) {
            const idx = order.items.findIndex(i => i.productId.toString() === productId.toString());
            if (idx === -1) continue;
            const removed = order.items.splice(idx, 1)[0];
            // Best-effort inventory restore via event (inventory-service listens to order.status_updated with items)
            bus.emit('order.item_removed', { orderId: order._id, productId: removed.productId, qty: removed.qty });
        }

        // Add items: validate stock
        for (const item of addItems) {
            try {
                const controller = new AbortController();
                setTimeout(() => controller.abort(), 2500);
                const r = await fetch(`http://localhost:5006/stock/${item.productId}`, { signal: controller.signal });
                if (r.ok) {
                    const { available } = await r.json();
                    if (available !== null && available < item.qty) {
                        return errorResponse(res, 400, `Insufficient stock for "${item.title || item.productId}"`);
                    }
                }
            } catch { /* fail open */ }
            order.items.push(item);
        }

        // Recalculate totalAmount
        order.totalAmount = order.items.reduce((sum, i) => sum + (i.price * i.qty), 0);
        await order.save();

        const sellerIds = [...new Set(order.items.map(i => i.sellerId?.toString()).filter(Boolean))];
        bus.emit('order.modified', {
            orderId:  order._id,
            buyerId:  order.buyerId,
            sellerIds,
            changes:  { addItems, removeItems }
        });

        res.json(order);
    } catch (err) { errorResponse(res, 500, err.message); }
});

// GET /my-sales — seller's received orders
app.get('/my-sales', async (req, res) => {
    try {
        if (!req.user?.storeId) return res.status(403).json({ error: true, message: 'Seller token required' });
        const orders = await Order.find({
            'items.sellerId': req.user.storeId,
            status: { $nin: ['cancelled'] }
        }).sort({ createdAt: -1 }).limit(100);
        res.json(orders);
    } catch (err) { res.status(500).json({ error: true, message: err.message }); }
});

// GET /:id/transitions — allowed status transitions for this order (seller use)
app.get('/:id/transitions', async (req, res) => {
    try {
        const order = await Order.findById(req.params.id);
        if (!order) return res.status(404).json({ error: true, message: 'Order not found' });

        let sellerTransitions = {
            pending:    ['processing', 'cancelled'],
            paid:       ['processing', 'cancelled'],
            processing: ['cancelled']
        };
        if (order.fulfillmentType === 'pickup') {
            sellerTransitions.processing       = [...(sellerTransitions.processing || []), 'ready_for_pickup'];
            sellerTransitions.ready_for_pickup = ['picked_up'];
        }
        if (order.fulfillmentType === 'self_fulfilled') {
            sellerTransitions.processing = [...(sellerTransitions.processing || []), 'self_fulfilled'];
        }

        const allowed = (sellerTransitions[order.status] || []).slice();

        res.json({
            current:         order.status,
            allowed,
            fulfillmentType: order.fulfillmentType || 'shipping'
        });
    } catch (err) { res.status(500).json({ error: true, message: err.message }); }
});

// Single order — sellerNote stripped for buyers
app.get('/:id', async (req, res) => {
    try {
        const order = await Order.findById(req.params.id);
        if (!order) return errorResponse(res, 404, 'Order not found');
        const userId  = req.user?.sub;
        const storeId = req.user?.storeId;
        const isBuyer  = order.buyerId.toString() === userId;
        const isSeller = order.items.some(i => i.sellerId?.toString() === storeId?.toString());
        const isAdmin  = req.user?.role === 'admin';
        if (!isBuyer && !isSeller && !isAdmin) return errorResponse(res, 403, 'Access denied');
        const doc = order.toObject();
        if (isBuyer && !isAdmin) delete doc.sellerNote; // hidden from buyer
        res.json(doc);
    } catch (err) { errorResponse(res, 500, err.message); }
});

// Manual status update
app.patch('/:id/status', async (req, res) => {
    try {
        const { status, cancellationReason } = req.body;
        const order = await Order.findById(req.params.id);
        if (!order) return errorResponse(res, 404, 'Order not found');

        const userId  = req.user?.sub;
        const storeId = req.user?.storeId;
        const role    = req.user?.role;
        const isAdmin = role === 'admin';

        const isBuyer  = order.buyerId?.toString() === userId;
        const isSeller = storeId && order.items.some(i => i.sellerId?.toString() === storeId);

        if (!isBuyer && !isSeller && !isAdmin) {
            return errorResponse(res, 403, 'You do not have permission to update this order');
        }

        let sellerTransitions = {
            pending:    ['processing', 'cancelled'],
            paid:       ['processing', 'cancelled'],
            processing: ['cancelled']
        };
        if (order.fulfillmentType === 'pickup') {
            sellerTransitions.processing       = [...(sellerTransitions.processing || []), 'ready_for_pickup'];
            sellerTransitions.ready_for_pickup = ['picked_up'];
        }
        if (order.fulfillmentType === 'self_fulfilled') {
            sellerTransitions.processing = [...(sellerTransitions.processing || []), 'self_fulfilled'];
        }
        let buyerTransitions = { pending: ['cancelled'] };

        let allowed;
        if (isAdmin) {
            allowed = MANUAL_TRANSITIONS[order.status] || [];
            const sellerAllowed = sellerTransitions[order.status] || [];
            allowed = [...new Set([...allowed, ...sellerAllowed])];
        } else if (isSeller) {
            allowed = sellerTransitions[order.status] || [];
        } else {
            allowed = buyerTransitions[order.status] || [];
        }

        if (!allowed.includes(status)) {
            return errorResponse(res, 400,
                `Cannot move from '${order.status}' to '${status}'. Allowed: [${allowed.join(', ') || 'none'}]`
            );
        }

        const extra = {};
        if (status === 'cancelled') {
            const actor  = isSeller ? 'Seller' : isAdmin ? 'Admin' : 'Buyer';
            const reason = cancellationReason ? `${actor}: ${cancellationReason}` : `${actor} cancelled this order.`;
            extra.cancellationReason   = reason;
            extra.cancellationCategory = isSeller ? 'seller_request' : isAdmin ? 'admin_action' : 'buyer_request';
        }

        const updated = await advanceStatus(req.params.id, status, extra);

        if (status === 'ready_for_pickup') {
            bus.emit('order.ready_for_pickup', { orderId: updated._id, buyerId: updated.buyerId, sellerId: storeId, items: updated.items });
        } else if (status === 'picked_up') {
            bus.emit('order.picked_up', { orderId: updated._id, buyerId: updated.buyerId, sellerId: storeId });
        } else if (status === 'self_fulfilled') {
            bus.emit('order.self_fulfilled', { orderId: updated._id, buyerId: updated.buyerId, sellerId: storeId });
        }

        res.json(updated);
    } catch (err) { errorResponse(res, 500, err.message); }
});

// Seller: mark an order as delivered (COD)
app.patch('/:id/deliver', async (req, res) => {
    try {
        const order   = await Order.findById(req.params.id);
        if (!order) return errorResponse(res, 404, 'Order not found');
        const storeId = req.user?.storeId;
        const isAdmin = req.user?.role === 'admin';
        const isSeller = storeId && order.items.some(i => i.sellerId?.toString() === storeId);
        if (!isSeller && !isAdmin) return errorResponse(res, 403, 'Seller or admin only');
        if (order.status !== 'shipped') {
            return errorResponse(res, 400, `Order must be 'shipped' to mark as delivered (current: ${order.status})`);
        }
        const updated = await advanceStatus(req.params.id, 'delivered');
        bus.emit('shipment.delivered', {
            orderId:  order._id,
            sellerId: storeId,
            buyerId:  order.buyerId,
            items:    order.items.map(i => ({ productId: i.productId, title: i.title }))
        });
        res.json(updated);
    } catch (err) { errorResponse(res, 500, err.message); }
});



app.listen(process.env.PORT || 5003, () => console.log(`Order Service on port ${process.env.PORT || 5003}`));
