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
db.on('connected', () => console.log('Inventory DB Connected'));
db.on('error', (err) => console.error('[INVENTORY] DB error:', err.message));

app.get('/health', (req, res) => {
    res.json({ service: 'inventory-service', status: 'ok', dbState: db.readyState === 1 ? 'connected' : 'disconnected' });
});

const InventorySchema = new mongoose.Schema({
    productId:         { type: mongoose.Schema.Types.ObjectId, required: true, unique: true },
    sellerId:          { type: mongoose.Schema.Types.ObjectId, required: true, index: true },
    quantity:          { type: Number, required: true, default: 0 },
    reserved:          { type: Number, default: 0 },
    lowStockThreshold: { type: Number, default: 5 },
    updatedAt:         { type: Date, default: Date.now },
    // S13 — Audit log: every stock mutation appended here, capped at 50 via application-layer slice
    auditLog: [{
        field:     { type: String, enum: ['quantity', 'reserved'] },
        oldValue:  Number,
        newValue:  Number,
        reason:    { type: String, enum: ['manual_update', 'order_reserved', 'order_cancelled', 'order_delivered', 'reservation_expired'] },
        changedBy: mongoose.Schema.Types.ObjectId,
        timestamp: { type: Date, default: Date.now }
    }],
    // S14 — Low-stock dedup gate: only emit inventory.stock_low once per 24h per product
    lowStockAlertedAt: Date,
    // S16 — Forecasting: rolling 30-day order count for avgDailySales projection
    rollingOrderCount:  { type: Number, default: 0 },
    rollingWindowStart: { type: Date, default: Date.now }
});
const Inventory = db.model('Inventory', InventorySchema);

// S15 — Restock requests: buyer signals interest for an out-of-stock product
const RestockRequestSchema = new mongoose.Schema({
    productId: { type: mongoose.Schema.Types.ObjectId, required: true },
    userId:    { type: mongoose.Schema.Types.ObjectId, required: true },
    createdAt: { type: Date, default: Date.now }
});
RestockRequestSchema.index({ productId: 1, userId: 1 }, { unique: true });
RestockRequestSchema.index({ productId: 1 });
const RestockRequest = db.model('RestockRequest', RestockRequestSchema);

// S17 — Reservation records: tracks per-item reservations; auto-cancels abandoned pending orders after 30min
const ReservationSchema = new mongoose.Schema({
    orderId:    { type: mongoose.Schema.Types.ObjectId, required: true },
    productId:  { type: mongoose.Schema.Types.ObjectId, required: true },
    qty:        { type: Number, required: true },
    reservedAt: { type: Date, default: Date.now },
    expiresAt:  { type: Date, required: true }
});
ReservationSchema.index({ expiresAt: 1 });  // sweep query
ReservationSchema.index({ orderId: 1 });    // cleanup on payment
const Reservation = db.model('Reservation', ReservationSchema);

// ── S13 helper ────────────────────────────────────────────────────────────────

// Appends an audit entry and slices to keep last 50. Call AFTER the atomic update;
// pass the pre-update values as oldValue and the post-update newValue.
async function writeAuditEntry(productId, field, oldValue, newValue, reason, changedBy = null) {
    try {
        await Inventory.updateOne(
            { productId },
            {
                $push: {
                    auditLog: {
                        $each:  [{ field, oldValue, newValue, reason, changedBy, timestamp: new Date() }],
                        $slice: -50
                    }
                }
            }
        );
    } catch (err) { console.error('[INVENTORY] auditLog write error:', err.message); }
}

// ── S9 helper — best-effort bundle detection via catalog-service ──────────────
async function getBundleItems(productId) {
    try {
        const controller = new AbortController();
        setTimeout(() => controller.abort(), 2500);
        const r = await fetch(`http://localhost:5002/products/${productId}`, { signal: controller.signal });
        if (!r.ok) return null;
        const p = await r.json();
        return p.type === 'bundle' ? (p.bundleItems || []) : null;
    } catch { return null; }
}

// ── Event listeners ──────────────────────────────────────────────────────────

bus.on('product.created', async (payload) => {
    try {
        await Inventory.create({ productId: payload.productId, sellerId: payload.sellerId, quantity: payload.initialQuantity || 0 });
        console.log(`[INVENTORY] Record created for product ${payload.productId}`);
    } catch (err) { console.error('[INVENTORY] product.created error:', err.message); }
});

bus.on('order.placed', async (payload) => {
    const EXPIRY_MS = 30 * 60 * 1000; // 30 minutes

    for (const item of payload.items) {
        // S9 — Bundle detection: route reservations to components, not the bundle productId
        const bundleItems = await getBundleItems(item.productId);

        // Items to reserve: either the bundle's components, or the item itself
        const toReserve = bundleItems
            ? bundleItems.map(b => ({ productId: b.productId, qty: b.qty * (item.qty || 1), title: b.title || '' }))
            : [{ productId: item.productId, qty: item.qty, title: item.title }];

        for (const reserveItem of toReserve) {
            try {
                const inv = await Inventory.findOneAndUpdate(
                    {
                        productId: reserveItem.productId,
                        $expr: { $gte: [{ $subtract: ['$quantity', '$reserved'] }, reserveItem.qty] }
                    },
                    {
                        $inc: { reserved: reserveItem.qty },
                        $set: { updatedAt: new Date() }
                    },
                    { new: true }
                );

                if (!inv) {
                    const currentInv = await Inventory.findOne({ productId: reserveItem.productId });
                    const currentAvail = currentInv ? (currentInv.quantity - currentInv.reserved) : 0;
                    const reason = currentInv
                        ? `"${reserveItem.title || 'An item'}" is out of stock (${currentAvail} available, ${reserveItem.qty} requested).`
                        : `"${reserveItem.title || 'An item'}" has no inventory record — the seller may need to update their stock.`;

                    bus.emit('order.inventory_failed', {
                        orderId:   payload.orderId,
                        productId: reserveItem.productId,
                        sellerId:  item.sellerId,
                        reason
                    });

                    if (item.sellerId) {
                        bus.emit('inventory.purchase_blocked', {
                            sellerId:  item.sellerId,
                            productId: reserveItem.productId,
                            title:     reserveItem.title || 'Unknown product',
                            qtyWanted: reserveItem.qty,
                            available: currentAvail,
                            buyerId:   payload.buyerId,
                            orderId:   payload.orderId
                        });
                    }
                    return;
                }

                // S13 — Audit log
                const oldReserved = inv.reserved - reserveItem.qty;
                await writeAuditEntry(reserveItem.productId, 'reserved', oldReserved, inv.reserved, 'order_reserved');

                // S14 — Low-stock dedup: emit only if not alerted within 24h
                const available = inv.quantity - inv.reserved;
                if (available < inv.lowStockThreshold) {
                    const now = Date.now();
                    const alertedAt = inv.lowStockAlertedAt ? new Date(inv.lowStockAlertedAt).getTime() : 0;
                    if (!alertedAt || now - alertedAt > 24 * 60 * 60 * 1000) {
                        bus.emit('inventory.stock_low', {
                            productId: inv.productId,
                            sellerId:  inv.sellerId,
                            quantity:  available
                        });
                        await Inventory.updateOne({ productId: inv.productId }, { lowStockAlertedAt: new Date() });
                    }
                }

                // S17 — Write reservation record for expiry sweep
                await Reservation.create({
                    orderId:   payload.orderId,
                    productId: reserveItem.productId,
                    qty:       reserveItem.qty,
                    expiresAt: new Date(Date.now() + EXPIRY_MS)
                });

                // S16 — Forecasting: increment rollingOrderCount, reset window if > 30 days old
                const invForForecast = await Inventory.findOne({ productId: reserveItem.productId });
                if (invForForecast) {
                    const windowAge = Date.now() - new Date(invForForecast.rollingWindowStart).getTime();
                    if (windowAge > 30 * 24 * 60 * 60 * 1000) {
                        await Inventory.updateOne({ productId: reserveItem.productId }, {
                            rollingOrderCount: 1,
                            rollingWindowStart: new Date()
                        });
                    } else {
                        await Inventory.updateOne({ productId: reserveItem.productId }, { $inc: { rollingOrderCount: 1 } });
                    }
                }

                console.log(`[INVENTORY] Reserved ${reserveItem.qty} units of product ${reserveItem.productId}`);
            } catch (err) { console.error('[INVENTORY] order.placed reservation error:', err.message); }
        }
    }
});

bus.on('order.inventory_failed', async (payload) => {
    console.log(`[INVENTORY] order.inventory_failed for order ${payload.orderId} — no partial reservation to restore`);
});

bus.on('order.status_updated', async (payload) => {
    if (payload.status === 'cancelled' && Array.isArray(payload.items)) {
        for (const item of payload.items) {
            try {
                const inv = await Inventory.findOne({ productId: item.productId });
                const oldReserved = inv?.reserved ?? 0;
                await Inventory.findOneAndUpdate(
                    { productId: item.productId },
                    { $inc: { reserved: -item.qty }, $set: { updatedAt: new Date() } }
                );
                // S13 — Audit log for cancellation restore
                await writeAuditEntry(item.productId, 'reserved', oldReserved, Math.max(0, oldReserved - item.qty), 'order_cancelled');
                console.log(`[INVENTORY] Restored ${item.qty} reserved units for product ${item.productId} (order cancelled)`);
            } catch (err) { console.error('[INVENTORY] cancel stock restoration error:', err.message); }
        }
    }
});

// Shipping auto-cancellation: restore reserved stock
bus.on('shipment.auto_cancelled', async (payload) => {
    if (!Array.isArray(payload.items)) return;
    for (const item of payload.items) {
        try {
            const inv = await Inventory.findOne({ productId: item.productId });
            const oldReserved = inv?.reserved ?? 0;
            await Inventory.findOneAndUpdate(
                { productId: item.productId },
                { $inc: { reserved: -item.qty }, $set: { updatedAt: new Date() } }
            );
            await writeAuditEntry(item.productId, 'reserved', oldReserved, Math.max(0, oldReserved - item.qty), 'order_cancelled');
            console.log(`[INVENTORY] Restored ${item.qty} reserved units for product ${item.productId} (shipment.auto_cancelled)`);
        } catch (err) { console.error('[INVENTORY] shipment.auto_cancelled restore error:', err.message); }
    }
});

// Buyer pickup no-show: restore reserved stock
bus.on('shipment.pickup_noshow', async (payload) => {
    if (!Array.isArray(payload.items)) return;
    for (const item of payload.items) {
        try {
            const inv = await Inventory.findOne({ productId: item.productId });
            const oldReserved = inv?.reserved ?? 0;
            await Inventory.findOneAndUpdate(
                { productId: item.productId },
                { $inc: { reserved: -item.qty }, $set: { updatedAt: new Date() } }
            );
            await writeAuditEntry(item.productId, 'reserved', oldReserved, Math.max(0, oldReserved - item.qty), 'order_cancelled');
            console.log(`[INVENTORY] Restored ${item.qty} reserved units for product ${item.productId} (shipment.pickup_noshow)`);
        } catch (err) { console.error('[INVENTORY] shipment.pickup_noshow restore error:', err.message); }
    }
});

bus.on('user.deleted', async (payload) => {
    try {
        // R-I3 fix: accept storeId OR userId as the seller key
        const result = await Inventory.deleteMany({ sellerId: payload.storeId || payload.userId });
        // Also clean up restock watch requests the user placed as a buyer
        const rr = await RestockRequest.deleteMany({ userId: payload.userId });
        console.log(`[INVENTORY] Removed ${result.deletedCount} inventory + ${rr.deletedCount} restock requests for user ${payload.userId}`);
    } catch (err) { console.error('[INVENTORY] user.deleted cleanup error:', err.message); }
});

// S17 — Clear reservations when payment is confirmed (escrow or COD) — no expiry needed
bus.on('payment.captured', async (payload) => {
    try {
        await Reservation.deleteMany({ orderId: payload.orderId });
        console.log(`[INVENTORY] Cleared reservations for paid order ${payload.orderId}`);
    } catch (err) { console.error('[INVENTORY] payment.captured reservation cleanup error:', err.message); }
});

bus.on('payment.pending', async (payload) => {
    // COD acknowledged — reservations stay until payment.collected or expiry
    console.log(`[INVENTORY] COD order ${payload.orderId} — reservations held`);
});

bus.on('payment.collected', async (payload) => {
    try {
        await Reservation.deleteMany({ orderId: payload.orderId });
        console.log(`[INVENTORY] Cleared reservations for COD-collected order ${payload.orderId}`);
    } catch (err) { console.error('[INVENTORY] payment.collected reservation cleanup error:', err.message); }
});

// ── S17 — Reserved stock expiry sweep (runs every 5 minutes) ─────────────────
// Finds expired reservations, restores stock, emits order.reservation_expired
async function runReservationSweep() {
    try {
        const expired = await Reservation.find({ expiresAt: { $lte: new Date() } });
        if (!expired.length) return;

        // Group by orderId so we emit once per order
        const byOrder = {};
        for (const r of expired) {
            const oid = r.orderId.toString();
            if (!byOrder[oid]) byOrder[oid] = [];
            byOrder[oid].push(r);
        }

        for (const [orderId, reservations] of Object.entries(byOrder)) {
            const items = [];
            for (const r of reservations) {
                try {
                    const inv = await Inventory.findOne({ productId: r.productId });
                    const oldReserved = inv?.reserved ?? 0;
                    await Inventory.updateOne(
                        { productId: r.productId },
                        { $inc: { reserved: -r.qty }, $set: { updatedAt: new Date() } }
                    );
                    // S13 — Audit log for expiry
                    await writeAuditEntry(r.productId, 'reserved', oldReserved, Math.max(0, oldReserved - r.qty), 'reservation_expired');
                    items.push({ productId: r.productId, qty: r.qty });
                } catch (err) { console.error('[INVENTORY] sweep restore error:', err.message); }
            }
            await Reservation.deleteMany({ orderId });
            bus.emit('order.reservation_expired', { orderId, items });
            console.log(`[INVENTORY] Reservation expired for order ${orderId} — stock restored, order.reservation_expired emitted`);
        }
    } catch (err) { console.error('[INVENTORY] reservation sweep error:', err.message); }
}

runReservationSweep(); // run immediately on startup — catches expirations during downtime
setInterval(runReservationSweep, 5 * 60 * 1000); // then every 5 minutes

// ── Routes ───────────────────────────────────────────────────────────────────

// Create an inventory record for a product (used when product was seeded without an event)
app.post('/', async (req, res) => {
    if (!req.user || !req.user.storeId) return errorResponse(res, 401, 'Unauthorized');
    const { productId, quantity = 0, lowStockThreshold = 5 } = req.body;
    if (!productId) return errorResponse(res, 400, 'productId required');
    try {
        const inv = await Inventory.findOneAndUpdate(
            { productId },
            { $setOnInsert: { productId, sellerId: req.user.storeId, quantity, reserved: 0, lowStockThreshold } },
            { upsert: true, new: true }
        );
        res.status(201).json({ ...inv.toObject(), available: inv.quantity - inv.reserved });
    } catch (err) { errorResponse(res, 500, err.message); }
});

// Public: returns only stock availability — no seller-sensitive data exposed
app.get('/stock/:productId', async (req, res) => {
    try {
        const inv = await Inventory.findOne({ productId: req.params.productId });
        if (!inv) return res.json({ available: null, lowStockThreshold: 5 });
        res.json({ available: inv.quantity - inv.reserved, lowStockThreshold: inv.lowStockThreshold });
    } catch (err) { errorResponse(res, 500, err.message); }
});

// S16 — Inventory forecasting: seller sees all their products with stockout projections (seller-scoped)
// MUST be before /:productId to prevent 'forecasting' being captured as a productId
app.get('/forecasting', async (req, res) => {
    if (!req.user?.storeId) return errorResponse(res, 401, 'Unauthorized');
    try {
        const records = await Inventory.find({ sellerId: req.user.storeId });
        const result = records.map(inv => {
            const available    = inv.quantity - inv.reserved;
            const windowDays   = Math.max(1, (Date.now() - new Date(inv.rollingWindowStart).getTime()) / 86400000);
            const avgDailySales = (inv.rollingOrderCount || 0) / windowDays;
            const daysUntilStockout = avgDailySales > 0 ? Math.floor(available / avgDailySales) : null;
            const urgency = daysUntilStockout === null ? 'healthy'
                : daysUntilStockout <= 7 ? 'critical'
                : daysUntilStockout <= 30 ? 'low'
                : 'healthy';
            return {
                productId: inv.productId,
                available,
                reserved:  inv.reserved,
                total:     inv.quantity,
                avgDailySales: Math.round(avgDailySales * 100) / 100,
                daysUntilStockout,
                urgency
            };
        });
        // Sort: critical first, then low, then healthy; null (no sales) last
        const order = { critical: 0, low: 1, healthy: 2 };
        result.sort((a, b) => {
            const uo = order[a.urgency] - order[b.urgency];
            if (uo !== 0) return uo;
            if (a.daysUntilStockout === null) return 1;
            if (b.daysUntilStockout === null) return -1;
            return a.daysUntilStockout - b.daysUntilStockout;
        });
        res.json(result);
    } catch (err) { errorResponse(res, 500, err.message); }
});

// S13 — Audit log for a product's inventory (seller-scoped)
// MUST be before /:productId
app.get('/log/:productId', async (req, res) => {
    try {
        const inv = await Inventory.findOne({ productId: req.params.productId });
        if (!inv) return errorResponse(res, 404, 'Inventory record not found');
        if (!req.user || inv.sellerId.toString() !== req.user.storeId) return errorResponse(res, 403, 'Not owned by you');
        const log = (inv.auditLog || []).slice().reverse(); // newest first
        res.json(log);
    } catch (err) { errorResponse(res, 500, err.message); }
});

app.get('/:productId', async (req, res) => {
    try {
        const inv = await Inventory.findOne({ productId: req.params.productId });
        if (!inv) return errorResponse(res, 404, 'Inventory record not found');
        if (!req.user || inv.sellerId.toString() !== req.user.storeId) return errorResponse(res, 403, 'Not owned by you');
        res.json({ ...inv.toObject(), available: inv.quantity - inv.reserved });
    } catch (err) { errorResponse(res, 500, err.message); }
});

app.put('/:productId', async (req, res) => {
    try {
        const inv = await Inventory.findOne({ productId: req.params.productId });
        if (!inv) return errorResponse(res, 404, 'Inventory record not found');
        if (!req.user || inv.sellerId.toString() !== req.user.storeId) return errorResponse(res, 403, 'Not owned by you');

        const oldQty      = inv.quantity;
        const wasZero     = (inv.quantity - inv.reserved) <= 0;

        if (req.body.quantity          !== undefined) inv.quantity          = req.body.quantity;
        if (req.body.reserved          !== undefined) inv.reserved          = req.body.reserved;
        if (req.body.lowStockThreshold !== undefined) inv.lowStockThreshold = req.body.lowStockThreshold;
        inv.updatedAt = new Date();

        // S14 — Reset lowStockAlertedAt when stock is replenished above threshold
        const newAvailable = inv.quantity - inv.reserved;
        if (newAvailable > inv.lowStockThreshold) {
            inv.lowStockAlertedAt = null;
        }

        await inv.save();

        // S13 — Audit log for manual update
        if (req.body.quantity !== undefined && req.body.quantity !== oldQty) {
            await writeAuditEntry(req.params.productId, 'quantity', oldQty, inv.quantity, 'manual_update', req.user.sub);
        }

        // S15 — If product was out of stock and is now restocked, notify waiting buyers
        if (wasZero && newAvailable > 0) {
            const requests = await RestockRequest.find({ productId: req.params.productId });
            if (requests.length) {
                bus.emit('inventory.restocked', {
                    productId:   inv.productId.toString(),
                    requestedBy: requests.map(r => r.userId.toString()),
                    newQuantity: inv.quantity
                });
                await RestockRequest.deleteMany({ productId: req.params.productId });
                console.log(`[INVENTORY] inventory.restocked emitted for ${req.params.productId}, notified ${requests.length} buyers`);
            }
        }

        bus.emit('inventory.updated', {
            productId: inv.productId.toString(),
            available: newAvailable,
            reserved:  inv.reserved,
            total:     inv.quantity
        });
        res.json({ ...inv.toObject(), available: newAvailable });
    } catch (err) { errorResponse(res, 500, err.message); }
});

// Seller can get all their inventory records
app.get('/', async (req, res) => {
    if (!req.user || !req.user.storeId) return errorResponse(res, 401, 'Unauthorized');
    try {
        const records = await Inventory.find({ sellerId: req.user.storeId });
        res.json(records.map(r => ({ ...r.toObject(), available: r.quantity - r.reserved })));
    } catch (err) { errorResponse(res, 500, err.message); }
});

// S15 — Restock request: buyer signals interest when product is out of stock
app.post('/restock-request/:productId', async (req, res) => {
    if (!req.user?.sub) return errorResponse(res, 401, 'Unauthorized');
    try {
        await RestockRequest.findOneAndUpdate(
            { productId: req.params.productId, userId: req.user.sub },
            { $setOnInsert: { productId: req.params.productId, userId: req.user.sub } },
            { upsert: true }
        );
        res.status(201).json({ ok: true });
    } catch (err) { errorResponse(res, 500, err.message); }
});

app.delete('/restock-request/:productId', async (req, res) => {
    if (!req.user?.sub) return errorResponse(res, 401, 'Unauthorized');
    try {
        await RestockRequest.deleteOne({ productId: req.params.productId, userId: req.user.sub });
        res.json({ ok: true });
    } catch (err) { errorResponse(res, 500, err.message); }
});

// Seller sees count of buyers waiting for restock (not userIds)
app.get('/restock-requests/:productId', async (req, res) => {
    if (!req.user?.storeId) return errorResponse(res, 401, 'Unauthorized');
    try {
        const count = await RestockRequest.countDocuments({ productId: req.params.productId });
        res.json({ count });
    } catch (err) { errorResponse(res, 500, err.message); }
});

// POST /admin/adjust/:productId — admin override quantity
// Body: { delta: N } (relative, +add/-subtract) or { quantity: N } (absolute set)
app.post('/admin/adjust/:productId', async (req, res) => {
    if (!req.headers['x-admin-email']) return errorResponse(res, 403, 'Admin only');
    try {
        const { delta, quantity, reason } = req.body;
        const inv = await Inventory.findOne({ productId: req.params.productId });
        if (!inv) return errorResponse(res, 404, 'Inventory record not found');
        const oldQty = inv.quantity;
        if (delta !== undefined) {
            inv.quantity = Math.max(0, inv.quantity + parseInt(delta));
        } else if (quantity !== undefined) {
            inv.quantity = Math.max(0, parseInt(quantity));
        } else {
            return errorResponse(res, 400, 'delta or quantity required');
        }
        inv.updatedAt = new Date();
        await inv.save();
        const adminEmail = req.headers['x-admin-email'];
        await writeAuditEntry(req.params.productId, 'quantity', oldQty, inv.quantity, reason || 'admin_adjust', adminEmail);
        bus.emit('inventory.updated', { productId: inv.productId.toString(), available: inv.quantity - inv.reserved, reserved: inv.reserved, total: inv.quantity });
        res.json({ success: true, productId: req.params.productId, quantity });
    } catch (err) { errorResponse(res, 500, err.message); }
});

// POST /admin/freeze/:productId — admin set inventory to 0 (freeze sales)
app.post('/admin/freeze/:productId', async (req, res) => {
    if (!req.headers['x-admin-email']) return errorResponse(res, 403, 'Admin only');
    try {
        const { reason } = req.body;
        const inv = await Inventory.findOne({ productId: req.params.productId });
        if (!inv) return errorResponse(res, 404, 'Inventory record not found');
        const oldQty = inv.quantity;
        inv.quantity  = 0;
        inv.updatedAt = new Date();
        await inv.save();
        await writeAuditEntry(req.params.productId, 'quantity', oldQty, 0, reason || 'admin_freeze', req.headers['x-admin-email']);
        bus.emit('inventory.updated', { productId: inv.productId.toString(), available: 0, reserved: inv.reserved, total: 0 });
        res.json({ success: true, productId: req.params.productId, frozen: true });
    } catch (err) { errorResponse(res, 500, err.message); }
});

// S18 — Bulk stock update: seller updates up to 50 products in one request
app.patch('/bulk', async (req, res) => {
    if (!req.user?.storeId) return errorResponse(res, 401, 'Unauthorized');
    const items = req.body;
    if (!Array.isArray(items) || !items.length) return errorResponse(res, 400, 'Body must be a non-empty array');
    if (items.length > 50) return errorResponse(res, 400, 'Maximum 50 items per bulk update');

    const updated = [];
    const failed  = [];

    for (const item of items) {
        const { productId, quantity, reason } = item;
        if (!productId || quantity === undefined) { failed.push({ productId, error: 'productId and quantity required' }); continue; }
        try {
            const inv = await Inventory.findOne({ productId });
            if (!inv) { failed.push({ productId, error: 'Inventory record not found' }); continue; }
            if (inv.sellerId.toString() !== req.user.storeId) { failed.push({ productId, error: 'Not owned by you' }); continue; }
            const oldQty = inv.quantity;
            inv.quantity  = quantity;
            inv.updatedAt = new Date();
            await inv.save();
            await writeAuditEntry(productId, 'quantity', oldQty, quantity, reason || 'manual_update', req.user.sub);
            updated.push(productId);
        } catch (err) { failed.push({ productId, error: err.message }); }
    }

    res.json({ updated: updated.length, failed });
});

// ── Admin Routes ─────────────────────────────────────────────────────────────

// GET /admin/inventory — all inventory records, filterable
// Query: sellerId, outOfStock (boolean), belowThreshold (boolean), page=1, limit=50
app.get('/admin/inventory', async (req, res) => {
    if (!req.headers['x-admin-email'] && req.user?.role !== 'admin') return errorResponse(res, 403, 'Admin only');
    try {
        const { sellerId, outOfStock, belowThreshold, page = 1, limit = 50 } = req.query;
        const query = {};
        if (sellerId) query.sellerId = sellerId;
        if (outOfStock === 'true') query.quantity = 0;
        if (belowThreshold === 'true') {
            // quantity > 0 and quantity <= lowStockThreshold
            query.$expr = { $and: [{ $gt: ['$quantity', 0] }, { $lte: ['$quantity', '$lowStockThreshold'] }] };
        }
        const skip = (parseInt(page) - 1) * parseInt(limit);
        const lim  = Math.min(parseInt(limit), 200);
        const [records, total] = await Promise.all([
            Inventory.find(query).skip(skip).limit(lim),
            Inventory.countDocuments(query)
        ]);
        res.json({ records, total });
    } catch (err) { errorResponse(res, 500, err.message); }
});

// GET /admin/inventory/out-of-stock — all products where quantity === 0
app.get('/admin/inventory/out-of-stock', async (req, res) => {
    if (!req.headers['x-admin-email'] && req.user?.role !== 'admin') return errorResponse(res, 403, 'Admin only');
    try {
        const records = await Inventory.find({ quantity: 0 });
        res.json({ records, total: records.length });
    } catch (err) { errorResponse(res, 500, err.message); }
});

// GET /admin/inventory/dormant-stock — quantity > 0, updatedAt < 60 days ago
app.get('/admin/inventory/dormant-stock', async (req, res) => {
    if (!req.headers['x-admin-email'] && req.user?.role !== 'admin') return errorResponse(res, 403, 'Admin only');
    try {
        const cutoff = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000);
        const records = await Inventory.find({ quantity: { $gt: 0 }, updatedAt: { $lt: cutoff } });
        res.json({ records, total: records.length });
    } catch (err) { errorResponse(res, 500, err.message); }
});

// GET /admin/inventory/reservation-summary — all active reservations, paginated
app.get('/admin/inventory/reservation-summary', async (req, res) => {
    if (!req.headers['x-admin-email'] && req.user?.role !== 'admin') return errorResponse(res, 403, 'Admin only');
    try {
        const { page = 1, limit = 50 } = req.query;
        const skip = (parseInt(page) - 1) * parseInt(limit);
        const lim  = Math.min(parseInt(limit), 200);
        const [records, total] = await Promise.all([
            Reservation.find().skip(skip).limit(lim),
            Reservation.countDocuments()
        ]);
        res.json({ records, total });
    } catch (err) { errorResponse(res, 500, err.message); }
});



app.listen(process.env.PORT || 5006, () => console.log(`Inventory Service on port ${process.env.PORT || 5006}`));
