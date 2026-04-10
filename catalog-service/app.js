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

// S5 — Product review/approval flow gate.
const REVIEW_ENABLED = process.env.PRODUCT_REVIEW_ENABLED === 'true';

const db = mongoose.createConnection(process.env.MONGODB_URI);
db.on('connected', () => console.log('Catalog DB Connected'));
db.on('error', (err) => console.error('[CATALOG] DB error:', err.message));

app.get('/health', (req, res) => {
    res.json({ service: 'catalog-service', status: 'ok', dbState: db.readyState === 1 ? 'connected' : 'disconnected' });
});

// S1/S5 — Q&A sub-document (must be defined before ProductSchema)
const QuestionSchema = new mongoose.Schema({
    askerId:   { type: mongoose.Schema.Types.ObjectId, required: true },
    body:      { type: String, required: true, maxLength: 500 },
    answer: {
        body:       String,
        answeredAt: Date
    },
    // nudgeSent guards the 48h unanswered sweep (S12) — seller notified only once per question
    nudgeSent: { type: Boolean, default: false },
    status:    { type: String, enum: ['open', 'answered'], default: 'open' },
    askedAt:   { type: Date, default: Date.now }
}, { _id: true });

const ProductSchema = new mongoose.Schema({
    sellerId:    { type: mongoose.Schema.Types.ObjectId, required: true },
    title:       { type: String, required: true },
    description: String,
    category:    { type: String, required: true },
    price:           { type: Number, required: true },
    images:          [String],
    attributes:      { type: Map, of: mongoose.Schema.Types.Mixed },
    avgRating:       { type: Number, default: 0 },
    // Fast delivery fee in cents — set by the seller. 0 = not offered.
    fastDeliveryFee: { type: Number, default: 0, min: 0 },
    smartMetrics: {
        viewCount:       { type: Number, default: 0 },
        activeCartCount: { type: Number, default: 0 },
        watchCount:      { type: Number, default: 0 },
        velocityScore:   { type: Number, default: 0.0 },
        qualityScore:    { type: Number, default: 100 }
    },
    // Product-level discount (applied in addition to or instead of store discount — whichever is higher)
    discount: {
        enabled: { type: Boolean, default: false },
        percent: { type: Number, default: 0, min: 0, max: 100 },
        endsAt:  { type: Date }
    },
    // Status: default controlled by PRODUCT_REVIEW_ENABLED at startup.
    // When false (default): 'active' — existing behavior. When true: 'pending_review' — requires admin approval.
    // Enum expanded to include pending_review and rejected (S5). Existing active products are not affected.
    status: {
        type:    String,
        enum:    ['active', 'paused', 'archived', 'deleted', 'pending_review', 'rejected'],
        default: REVIEW_ENABLED ? 'pending_review' : 'active'
    },
    createdAt:       { type: Date, default: Date.now },
    // Category hierarchy — subcategory filter alongside main category (S1/S10)
    subcategory:     { type: String, default: '' },
    // Product type system — 'bundle' documents carry bundleItems[]. Inventory routed to components (S1/S9)
    type:        { type: String, enum: ['product', 'bundle'], default: 'product' },
    bundleItems: [{
        productId: { type: mongoose.Schema.Types.ObjectId, required: true },
        qty:       { type: Number, required: true, min: 1 }
    }],
    // Price history — capped at 10 entries; oldest dropped on overflow (S1/S8)
    priceHistory: [{
        price:     { type: Number, required: true },
        changedAt: { type: Date, default: Date.now }
    }],
    // Review/approval metadata (S1/S5)
    rejectionReason: { type: String, default: '' },
    rejectionCount:  { type: Number, default: 0 },
    // Q&A — answered questions visible publicly; open questions visible to seller (S1/S12)
    questions: [QuestionSchema],
    // Reason a product was system-paused (null = not system-paused or manual pause)
    _pauseReason: { type: String, enum: ['seller_deactivated', 'account_deletion', null], default: null }
});
ProductSchema.index({ title: 'text', description: 'text' });
ProductSchema.index({ category: 1, subcategory: 1 });         // S10 — subcategory filter
ProductSchema.index({ status: 1, sellerId: 1 });              // S5  — per-seller moderation view
ProductSchema.index({ status: 1, createdAt: -1 });            // S5  — pending review queue (oldest first)
const Product = db.model('Product', ProductSchema);

// ── Helpers ───────────────────────────────────────────────────────────────────

// Computes the effective discount on a product, taking the higher of product-level
// and store-level discount. Returns null if no discount is active.
function effectiveDiscount(product, storeDiscount) {
    const productPct = product.discount?.enabled ? (product.discount.percent || 0) : 0;
    const storePct   = storeDiscount?.storeWide?.enabled ? (storeDiscount.storeWide.percent || 0) : 0;
    const pct        = Math.max(productPct, storePct);
    if (pct <= 0) return null;
    return {
        percent:         pct,
        discountedPrice: Math.round(product.price * (1 - pct / 100)),
        endsAt:          productPct >= storePct
            ? (product.discount?.endsAt || null)
            : (storeDiscount?.storeWide?.endsAt || null)
    };
}

// S11 — In-memory caches to avoid per-product HTTP calls on every list request
const stockStatusCache  = new Map();  // productId → { status, expiresAt } — 30s TTL
const sellerRatingCache = new Map();  // storeId   → { sellerAvgRating, expiresAt } — 60s TTL

// S11 — Confidence badge: computed at read time, no schema field
// Label rules: Highly Rated → Top Seller Item → New Listing → Established
function computeConfidenceBadge(product, sellerAvgRating) {
    const now         = Date.now();
    const ageMs       = now - new Date(product.createdAt).getTime();
    const ageDays     = ageMs / 86400000;
    const avgRating   = product.avgRating     || 0;
    const qualScore   = product.smartMetrics?.qualityScore || 0;

    if (avgRating >= 4.5) {
        return { label: 'Highly Rated', color: '#15803d', icon: 'fa-star', description: 'Consistently top-rated by buyers' };
    }
    if (qualScore >= 80 && (sellerAvgRating || 0) >= 4.0) {
        return { label: 'Top Seller Item', color: '#1d4ed8', icon: 'fa-shield-alt', description: 'From a highly rated seller' };
    }
    if (ageDays <= 30) {
        return { label: 'New Listing', color: '#7c3aed', icon: 'fa-sparkles', description: 'Recently listed' };
    }
    return { label: 'Established', color: '#6b7280', icon: 'fa-check', description: 'Listed product' };
}

// S11 — Best-effort stock status from inventory-service (cached 30s)
async function getStockStatus(productId) {
    const key    = productId.toString();
    const cached = stockStatusCache.get(key);
    if (cached && Date.now() < cached.expiresAt) return cached.status;
    try {
        const controller = new AbortController();
        setTimeout(() => controller.abort(), 2000);
        const r = await fetch(`http://localhost:5006/stock/${productId}`, { signal: controller.signal });
        if (!r.ok) { stockStatusCache.set(key, { status: 'unknown', expiresAt: Date.now() + 30000 }); return 'unknown'; }
        const { available, lowStockThreshold } = await r.json();
        const status = available === null ? 'unknown'
            : available === 0         ? 'out_of_stock'
            : available <= (lowStockThreshold || 5) ? 'low_stock'
            : 'in_stock';
        stockStatusCache.set(key, { status, expiresAt: Date.now() + 30000 });
        return status;
    } catch { stockStatusCache.set(key, { status: 'unknown', expiresAt: Date.now() + 30000 }); return 'unknown'; }
}

// S11 — Best-effort seller avg rating from seller-service (cached 60s)
async function getSellerRating(storeId) {
    const key    = storeId.toString();
    const cached = sellerRatingCache.get(key);
    if (cached && Date.now() < cached.expiresAt) return cached.sellerAvgRating;
    try {
        const controller = new AbortController();
        setTimeout(() => controller.abort(), 2000);
        const r = await fetch(`http://localhost:5005/by-seller/${storeId}`, { signal: controller.signal });
        if (!r.ok) { sellerRatingCache.set(key, { sellerAvgRating: 0, expiresAt: Date.now() + 60000 }); return 0; }
        const s = await r.json();
        sellerRatingCache.set(key, { sellerAvgRating: s.sellerAvgRating || 0, expiresAt: Date.now() + 60000 });
        return s.sellerAvgRating || 0;
    } catch { sellerRatingCache.set(key, { sellerAvgRating: 0, expiresAt: Date.now() + 60000 }); return 0; }
}

// ── Event listeners ──────────────────────────────────────────────────────────

bus.on('user.deleted', async (payload) => {
    try {
        const deleteId = payload.storeId || payload.userId;
        const result = await Product.deleteMany({ sellerId: deleteId });
        console.log(`[CATALOG] Removed ${result.deletedCount} products for seller ${deleteId}`);
    } catch (err) { console.error('[CATALOG] user.deleted cleanup error:', err.message); }
});

// Hide all seller's products immediately when self-deletion is initiated
bus.on('user.pending_deletion', async (payload) => {
    try {
        const storeId = payload.storeId;
        if (!storeId) return;
        const result = await Product.updateMany(
            { sellerId: storeId, status: 'active' },
            { status: 'paused', _pauseReason: 'account_deletion' }
        );
        console.log(`[CATALOG] Paused ${result.modifiedCount} products for pending deletion: storeId=${storeId}`);
    } catch (err) { console.error('[CATALOG] user.pending_deletion hide error:', err.message); }
});

// Restore hidden products if user cancels deletion within the 24h cooldown
bus.on('user.deletion_cancelled', async (payload) => {
    try {
        const storeId = payload.storeId;
        if (!storeId) return;
        const result = await Product.updateMany(
            { sellerId: storeId, status: 'paused', _pauseReason: 'account_deletion' },
            { status: 'active', _pauseReason: null }
        );
        console.log(`[CATALOG] Restored ${result.modifiedCount} products after deletion cancelled: storeId=${storeId}`);
    } catch (err) { console.error('[CATALOG] user.deletion_cancelled restore error:', err.message); }
});

bus.on('review.approved', async (payload) => {
    try {
        // Recalculate avgRating from all approved reviews for this product
        // We receive the new rating; recalc by averaging with existing
        const product = await Product.findById(payload.productId);
        if (!product) return;
        // Use a rolling count stored via the payload approach —
        // since we don't have review count here, re-calculate from scratch via the rating signal
        // The review service sends { productId, rating, avgRating } where avgRating is the computed average
        if (payload.avgRating !== undefined) {
            await Product.findByIdAndUpdate(payload.productId, { avgRating: payload.avgRating });
        } else {
            // Fallback: simple update with the new rating as a signal
            await Product.findByIdAndUpdate(payload.productId, { avgRating: payload.rating });
        }
        console.log(`[CATALOG] Updated avgRating for product ${payload.productId}`);
    } catch (err) { console.error('[CATALOG] review.approved error:', err.message); }
});

bus.on('product.updated', async (payload) => {
    // Relay to search service via event (search listens separately)
    // Nothing to do in catalog itself — this event is emitted by catalog
});

bus.on('seller.deactivated', async (payload) => {
    try {
        await Product.updateMany(
            { sellerId: payload.storeId, status: 'active' },
            { status: 'paused', _pauseReason: 'seller_deactivated' }
        );
        console.log(`[CATALOG] Paused products for deactivated store: ${payload.storeId}`);
    } catch (err) { console.error('[CATALOG] seller.deactivated error:', err.message); }
});

bus.on('seller.reactivated', async (payload) => {
    try {
        await Product.updateMany(
            { sellerId: payload.storeId, _pauseReason: 'seller_deactivated' },
            { status: 'active', _pauseReason: null }
        );
        console.log(`[CATALOG] Restored products for reactivated store: ${payload.storeId}`);
    } catch (err) { console.error('[CATALOG] seller.reactivated error:', err.message); }
});

// A.4: Smart catalog integration — quality reviews boost product score
bus.on('review.submitted', async (payload) => {
    try {
        if (payload.avgRating >= 4.0 && payload.reviewCount >= 5) {
            const p = await Product.findById(payload.productId);
            if (p && p.smartMetrics.qualityScore < 85) {
                p.smartMetrics.qualityScore = Math.min(100, p.smartMetrics.qualityScore + 15);
                await p.save();
                console.log(`[CATALOG] qualityScore boosted for product ${payload.productId} (avgRating=${payload.avgRating}, count=${payload.reviewCount})`);
            }
        }
    } catch (err) { console.error('[CATALOG] review.submitted boost error:', err.message); }
});

// ── Smart Catalog Event Listeners ─────────────────────────────────────────────
bus.on('order.placed', async (payload) => {
    try {
        for (const item of payload.items) {
            // S9 — Bundle items: deduct from components, not the bundle productId itself
            const p = await Product.findById(item.productId).select('type bundleItems');
            if (p?.type === 'bundle' && p.bundleItems?.length) {
                for (const comp of p.bundleItems) {
                    await Product.updateOne({ _id: comp.productId }, { $inc: { 'smartMetrics.activeCartCount': -(comp.qty * (item.qty || 1)) } });
                }
            } else {
                await Product.updateOne({ _id: item.productId }, { $inc: { 'smartMetrics.activeCartCount': -(item.qty || 1) } });
            }
        }
    } catch (err) { console.error('[CATALOG] order.placed cart deduct error:', err.message); }
});

bus.on('user.watchlist_added', async (payload) => {
    try { await Product.updateOne({ _id: payload.productId }, { $inc: { 'smartMetrics.watchCount': 1 } }); } 
    catch (err) { console.error('[CATALOG] watch tracking error:', err.message); }
});

bus.on('user.watchlist_removed', async (payload) => {
    try { await Product.updateOne({ _id: payload.productId }, { $inc: { 'smartMetrics.watchCount': -1 } }); } 
    catch (err) { console.error('[CATALOG] watch tracking error:', err.message); }
});

bus.on('product.dwelled', async (payload) => {
    try { 
        // Direct velocity boost for high-intent observation
        const p = await Product.findById(payload.productId);
        if (p && p.smartMetrics) {
            p.smartMetrics.velocityScore += (payload.durationSeconds || 15) * 0.1;
            await p.save();
        }
    } 
    catch (err) {}
});

// Velocity / Decay Engine (Runs every 2 mins)
setInterval(async () => {
    try {
        const products = await Product.find({ status: 'active' });
        for (const p of products) {
            const m = p.smartMetrics || {};
            // Simple momentum evaluation logic
            let newVel = (m.viewCount * 0.05) + (m.activeCartCount * 5) + (m.watchCount * 3);
            if (Math.abs(newVel - m.velocityScore) > 1.0) {
                p.smartMetrics.velocityScore = newVel;
                await p.save();
                bus.emit('product.metrics_updated', {
                    productId: p._id,
                    velocityScore: newVel,
                    qualityScore: m.qualityScore,
                    activeCartCount: m.activeCartCount
                });
            }
        }
    } catch (err) { console.error('[CATALOG] Velocity Engine error:', err.message); }
}, 120000);

// ── Routes ───────────────────────────────────────────────────────────────────

app.post('/products', async (req, res) => {
    if (!req.user || !req.user.storeId) return errorResponse(res, 403, 'Missing storeId claim');
    try {
        // S9 — Bundle validation: bundleItems must be non-empty and reference only non-bundle products
        if (req.body.type === 'bundle') {
            const items = req.body.bundleItems;
            if (!items || !items.length) return errorResponse(res, 400, 'Bundles must have at least one bundleItem');
            const components = await Product.find({ _id: { $in: items.map(i => i.productId) } }).select('type');
            if (components.some(c => c.type === 'bundle')) return errorResponse(res, 400, 'Bundles cannot contain other bundles');
            if (components.length !== items.length) return errorResponse(res, 400, 'One or more bundleItem productIds do not exist');
        }
        const product = await Product.create({ ...req.body, sellerId: req.user.storeId });
        // Best-effort storeName lookup — search index uses it for seller name matching
        let storeName = '';
        try {
            const sr = await fetch(`http://localhost:5005/by-seller/${product.sellerId}`);
            if (sr.ok) { const s = await sr.json(); storeName = s.name || ''; }
        } catch (_) { /* fail open — store.updated backfills */ }
        const disc = product.discount?.enabled
            ? { enabled: true, percent: product.discount.percent, discountedPrice: Math.round(product.price * (1 - product.discount.percent / 100)) }
            : { enabled: false, percent: 0, discountedPrice: product.price };
        bus.emit('product.created', {
            productId:   product._id,
            sellerId:    product.sellerId,
            title:       product.title,
            category:    product.category,
            price:       product.price,
            description: product.description || '',
            createdAt:   product.createdAt,
            discount:    disc,
            storeName
        });
        res.status(201).json(product);
    } catch (err) { errorResponse(res, 500, err.message); }
});

app.get('/products', async (req, res) => {
    try {
        const { category, subcategory, search, page = 1, limit = 20, shuffle } = req.query;
        const skip = (parseInt(page) - 1) * parseInt(limit);
        const lim  = Math.min(parseInt(limit), 50);

        if (shuffle === 'true') {
            const pipeline = [{ $match: { status: 'active' } }];
            if (category)    pipeline[0].$match.category    = category;
            if (subcategory) pipeline[0].$match.subcategory = subcategory; // S10
            if (search)      pipeline[0].$match.$or = [
                { title: { $regex: search, $options: 'i' } },
                { description: { $regex: search, $options: 'i' } }
            ];
            pipeline.push({ $sample: { size: lim } });
            return res.json(await Product.aggregate(pipeline));
        }

        let query = { status: 'active' };
        if (category)    query.category    = category;
        if (subcategory) query.subcategory = subcategory; // S10
        if (search)      query.$or = [
            { title: { $regex: search, $options: 'i' } },
            { description: { $regex: search, $options: 'i' } }
        ];
        res.json(await Product.find(query).sort({ createdAt: -1 }).skip(skip).limit(lim));
    } catch (err) { errorResponse(res, 500, err.message); }
});

app.get('/my-products', async (req, res) => {
    if (!req.user || !req.user.storeId) return errorResponse(res, 401, 'Unauthorized');
    try {
        const { includeArchived, subcategory } = req.query;
        const statusFilter = includeArchived === 'true'
            ? { $nin: ['deleted'] }
            : { $nin: ['deleted', 'archived'] };
        const query = { sellerId: req.user.storeId, status: statusFilter };
        if (subcategory) query.subcategory = subcategory; // S10
        res.json(await Product.find(query));
    } catch (err) { errorResponse(res, 500, err.message); }
});

// S5 — Admin: list products awaiting approval.
// MUST be defined before GET /products/:id so 'pending-review' is not captured as :id.
app.get('/products/pending-review', async (req, res) => {
    if (!req.user || req.user.role !== 'admin') return errorResponse(res, 403, 'Admin only');
    try {
        const { page = 1, limit = 50 } = req.query;
        const skip = (parseInt(page) - 1) * parseInt(limit);
        const lim  = Math.min(parseInt(limit), 100);
        const products = await Product.find({ status: 'pending_review' })
            .sort({ createdAt: 1 }) // oldest first — fair review queue
            .skip(skip).limit(lim);
        const total = await Product.countDocuments({ status: 'pending_review' });
        res.json({ products, total, page: parseInt(page), hasMore: skip + lim < total });
    } catch (err) { errorResponse(res, 500, err.message); }
});

app.get('/products/:id', async (req, res) => {
    try {
        const p = await Product.findById(req.params.id);
        if (!p) return errorResponse(res, 404, 'Not found');
        const doc = p.toObject();
        // S9 — Bundle enrichment: resolve component titles/images for display
        if (p.type === 'bundle' && p.bundleItems?.length) {
            const componentIds = p.bundleItems.map(b => b.productId);
            const components = await Product.find({ _id: { $in: componentIds } }).select('title images price').lean();
            const compMap = Object.fromEntries(components.map(c => [c._id.toString(), c]));
            doc.bundleItems = p.bundleItems.map(b => ({
                productId: b.productId,
                qty:       b.qty,
                title:     compMap[b.productId?.toString()]?.title  || '',
                image:     compMap[b.productId?.toString()]?.images?.[0] || '',
                price:     compMap[b.productId?.toString()]?.price  || 0
            }));
        }
        // S11 — Confidence badge + stock status (both best-effort, fail open)
        const [sellerRating, stockStatus] = await Promise.all([
            getSellerRating(p.sellerId),
            getStockStatus(p._id)
        ]);
        doc.confidenceBadge = computeConfidenceBadge(doc, sellerRating);
        doc.stockStatus     = stockStatus;
        res.json(doc);
    } catch (err) { errorResponse(res, 500, err.message); }
});

// S8 — Price history for a product (public — buyers see trend tooltip)
app.get('/products/:id/price-history', async (req, res) => {
    try {
        const p = await Product.findById(req.params.id).select('priceHistory price');
        if (!p) return errorResponse(res, 404, 'Not found');
        // Return newest-first; current price not in array but returned for context
        res.json({ currentPrice: p.price, history: (p.priceHistory || []) });
    } catch (err) { errorResponse(res, 500, err.message); }
});

// Public: all active products from a store — powers the storefront page
app.get('/by-seller/:storeId', async (req, res) => {
    try {
        // Fetch store discount config to compute effectiveDiscount per product
        let storeDiscount = null;
        try {
            const sellerRes = await fetch(`http://localhost:5005/by-seller-id/${req.params.storeId}`);
            // We use the internal GET /:storeId route (by store _id, not sellerId)
            const sdRes = await fetch(`http://localhost:5005/${req.params.storeId}`);
            if (sdRes.ok) {
                const sd = await sdRes.json();
                storeDiscount = sd.discount || null;
            }
        } catch (_) { /* fail open — discount just won't be computed */ }

        const products = await Product.find({
            sellerId: req.params.storeId,
            status: 'active'
        }).select('_id title price images category stock likes description discount smartMetrics avgRating createdAt').limit(48).lean();

        const result = products.map(p => ({
            ...p,
            discountInfo: effectiveDiscount(p, storeDiscount)
        }));
        res.json(result);
    } catch (err) { errorResponse(res, 500, err.message); }
});

// Public: stores with active sales banners — powers homepage "on sale" section
app.get('/on-sale', async (req, res) => {
    try {
        const sellerRes = await fetch('http://localhost:5005/on-sale-stores');
        if (!sellerRes.ok) return res.json([]);
        const stores = await sellerRes.json();
        res.json(stores);
    } catch (err) { res.json([]); } // fail gracefully — homepage must still load
});

// ── Smart Catalog: Telemetry Ingress & Debouncer ──────────────────────────────
const telemetryDebounce = new Map();
setInterval(async () => {
    if (telemetryDebounce.size === 0) return;
    const entries = Array.from(telemetryDebounce.entries());
    telemetryDebounce.clear();
    for (const [productId, updates] of entries) {
        try {
            await Product.updateOne({ _id: productId }, { $inc: updates });
        } catch (err) {
            console.error('[CATALOG] Debounce flush error:', err.message);
        }
    }
}, 10000);

app.post('/products/:id/telemetry', async (req, res) => {
    try {
        const { event, duration, qty, priceAtAdd, sellerId } = req.body;
        const productId = req.params.id;
        const userId = req.user?.sub;
        
        let updates = telemetryDebounce.get(productId) || {
            'smartMetrics.viewCount': 0,
            'smartMetrics.activeCartCount': 0
        };

        if (event === 'dwelled') {
            bus.emit('product.dwelled', { productId, userId, durationSeconds: duration });
        } else if (event === 'viewed') {
            updates['smartMetrics.viewCount'] += 1;
            bus.emit('product.detailed_view', { productId, userId, timestamp: new Date() });
        } else if (event === 'cart_added') {
            updates['smartMetrics.activeCartCount'] += (qty || 1);
            bus.emit('cart.item_added', { productId, sellerId, qty: qty || 1, priceAtAdd, userId });
        } else if (event === 'cart_removed') {
            updates['smartMetrics.activeCartCount'] -= (qty || 1);
            bus.emit('cart.item_removed', { productId, sellerId, qty: qty || 1, timeInCartSecs: duration });
        }
        
        telemetryDebounce.set(productId, updates);
        res.status(200).json({ accepted: true });
    } catch (err) {
        errorResponse(res, 500, err.message);
    }
});


app.put('/products/:id', async (req, res) => {
    try {
        const p = await Product.findById(req.params.id);
        if (!p) return errorResponse(res, 404, 'Not found');
        if (!req.user || p.sellerId.toString() !== req.user.storeId) return errorResponse(res, 403, 'Not owned by you');

        const oldPrice = p.price;
        // S8 — Price history: record old price before overwrite, cap at 10 entries
        if (req.body.price !== undefined && req.body.price !== p.price) {
            p.priceHistory.unshift({ price: p.price, changedAt: new Date() });
            if (p.priceHistory.length > 10) p.priceHistory = p.priceHistory.slice(0, 10);
        }
        Object.assign(p, req.body);
        await p.save();
        
        if (req.body.price !== undefined && req.body.price < oldPrice) {
            bus.emit('catalog.price_dropped', {
                productId: p._id,
                oldPrice,
                newPrice: p.price,
                sellerId: p.sellerId,
                title: p.title
            });
        }

        // Best-effort storeName lookup for search index resync
        let storeName = '';
        try {
            const sr = await fetch(`http://localhost:5005/by-seller/${p.sellerId}`);
            if (sr.ok) { const s = await sr.json(); storeName = s.name || ''; }
        } catch (_) { /* fail open */ }
        const disc = p.discount?.enabled
            ? { enabled: true, percent: p.discount.percent, discountedPrice: Math.round(p.price * (1 - p.discount.percent / 100)) }
            : { enabled: false, percent: 0, discountedPrice: p.price };
        bus.emit('product.updated', {
            productId:   p._id,
            title:       p.title,
            category:    p.category,
            price:       p.price,
            status:      p.status,
            description: p.description || '',
            discount:    disc,
            storeName
        });
        res.json(p);
    } catch (err) { errorResponse(res, 500, err.message); }
});

app.delete('/products/:id', async (req, res) => {
    try {
        const p = await Product.findById(req.params.id);
        if (!p) return errorResponse(res, 404, 'Not found');
        if (!req.user || p.sellerId.toString() !== req.user.storeId) return errorResponse(res, 403, 'Not owned by you');
        p.status = 'deleted';
        await p.save();
        bus.emit('product.deleted', { productId: p._id });
        res.json({ message: 'Deleted' });
    } catch (err) { errorResponse(res, 500, err.message); }
});

// Admin: flag a product as policy-violating — hides it from search and browse
app.post('/products/:id/flag', async (req, res) => {
    if (!req.user || req.user.role !== 'admin') return errorResponse(res, 403, 'Admin only');
    try {
        const p = await Product.findByIdAndUpdate(
            req.params.id,
            { status: 'paused' },
            { new: true }
        );
        if (!p) return errorResponse(res, 404, 'Not found');
        bus.emit('product.flagged', { productId: p._id });
        res.json({ message: 'Product flagged and hidden from search', productId: p._id });
    } catch (err) { errorResponse(res, 500, err.message); }
});

// S5 — Admin: approve a product in 'pending_review' — moves it to 'active' and notifies seller
app.post('/products/:id/approve', async (req, res) => {
    if (!req.user || req.user.role !== 'admin') return errorResponse(res, 403, 'Admin only');
    try {
        const p = await Product.findById(req.params.id);
        if (!p) return errorResponse(res, 404, 'Not found');
        if (p.status !== 'pending_review') return errorResponse(res, 400, `Cannot approve a product with status '${p.status}'`);
        p.status = 'active';
        await p.save();
        bus.emit('product.approved', {
            productId: p._id,
            sellerId:  p.sellerId,
            title:     p.title
        });
        res.json(p);
    } catch (err) { errorResponse(res, 500, err.message); }
});

// S5 — Admin: reject a product in 'pending_review' — stores reason, increments rejectionCount
app.post('/products/:id/reject', async (req, res) => {
    if (!req.user || req.user.role !== 'admin') return errorResponse(res, 403, 'Admin only');
    const { reason } = req.body;
    if (!reason || !reason.trim()) return errorResponse(res, 400, 'Rejection reason is required');
    try {
        const p = await Product.findById(req.params.id);
        if (!p) return errorResponse(res, 404, 'Not found');
        if (p.status !== 'pending_review') return errorResponse(res, 400, `Cannot reject a product with status '${p.status}'`);
        p.status = 'rejected';
        p.rejectionReason = reason.trim();
        p.rejectionCount  = (p.rejectionCount || 0) + 1;
        await p.save();
        bus.emit('product.rejected', {
            productId:  p._id,
            sellerId:   p.sellerId,
            title:      p.title,
            reason:     p.rejectionReason,
            rejectionCount: p.rejectionCount
        });
        // C-C5 — third consecutive rejection: alert seller with policy guidance
        if (p.rejectionCount >= 3) {
            bus.emit('seller.repeated_rejections', {
                sellerId: p.sellerId,
                count:    p.rejectionCount
            });
        }
        res.json(p);
    } catch (err) { errorResponse(res, 500, err.message); }
});

// S5 — Seller: resubmit a rejected product for re-review (status: 'rejected' → 'pending_review')
// Seller must edit the product via PUT /products/:id first, then resubmit.
app.post('/products/:id/resubmit', async (req, res) => {
    if (!req.user || !req.user.storeId) return errorResponse(res, 401, 'Unauthorized');
    try {
        const p = await Product.findById(req.params.id);
        if (!p) return errorResponse(res, 404, 'Not found');
        if (p.sellerId.toString() !== req.user.storeId) return errorResponse(res, 403, 'Not owned by you');
        if (p.status !== 'rejected') return errorResponse(res, 400, `Only rejected products can be resubmitted (current status: '${p.status}')`);
        p.status = 'pending_review';
        p.rejectionReason = ''; // cleared on resubmit
        await p.save();
        res.json(p);
    } catch (err) { errorResponse(res, 500, err.message); }
});

// Seller: feature/unfeature their own product — boosts browse ranking
app.post('/products/:id/feature', async (req, res) => {
    try {
        const p = await Product.findById(req.params.id);
        if (!p) return errorResponse(res, 404, 'Not found');
        if (!req.user || p.sellerId.toString() !== req.user.storeId) return errorResponse(res, 403, 'Not owned by you');
        const featured = req.body.featured !== false; // default true — feature flag lives in search index only
        bus.emit('product.featured', { productId: p._id, featured });
        res.json({ message: featured ? 'Product featured' : 'Product unfeatured', productId: p._id, featured });
    } catch (err) { errorResponse(res, 500, err.message); }
});

// S12 — Product Q&A
// POST /products/:id/questions — any authenticated buyer submits a question
app.post('/products/:id/questions', async (req, res) => {
    if (!req.user?.sub) return errorResponse(res, 401, 'Unauthorized');
    const { body } = req.body;
    if (!body?.trim()) return errorResponse(res, 400, 'Question body required');
    try {
        const p = await Product.findById(req.params.id);
        if (!p) return errorResponse(res, 404, 'Not found');
        const q = { askerId: req.user.sub, body: body.trim() };
        p.questions.push(q);
        await p.save();
        const added = p.questions[p.questions.length - 1];
        bus.emit('product.question_asked', {
            productId:  p._id,
            sellerId:   p.sellerId,
            questionId: added._id,
            preview:    body.trim().slice(0, 80)
        });
        res.status(201).json(added);
    } catch (err) { errorResponse(res, 500, err.message); }
});

// PATCH /products/:id/questions/:qid/answer — seller answers a question
app.patch('/products/:id/questions/:qid/answer', async (req, res) => {
    if (!req.user?.storeId) return errorResponse(res, 401, 'Unauthorized');
    const { body } = req.body;
    if (!body?.trim()) return errorResponse(res, 400, 'Answer body required');
    try {
        const p = await Product.findById(req.params.id);
        if (!p) return errorResponse(res, 404, 'Not found');
        if (p.sellerId.toString() !== req.user.storeId) return errorResponse(res, 403, 'Not owned by you');
        const q = p.questions.id(req.params.qid);
        if (!q) return errorResponse(res, 404, 'Question not found');
        q.answer    = { body: body.trim(), answeredAt: new Date() };
        q.status    = 'answered';
        q.nudgeSent = true; // mark so sweep doesn't re-nudge after answer
        await p.save();
        res.json(q);
    } catch (err) { errorResponse(res, 500, err.message); }
});

// GET /products/:id/questions — public sees answered; seller sees all
app.get('/products/:id/questions', async (req, res) => {
    try {
        const p = await Product.findById(req.params.id).select('questions sellerId');
        if (!p) return errorResponse(res, 404, 'Not found');
        const isSeller = req.user?.storeId && p.sellerId.toString() === req.user.storeId;
        const questions = isSeller
            ? p.questions // seller sees all (open + answered)
            : p.questions.filter(q => q.status === 'answered');
        res.json(questions.sort((a, b) => new Date(b.askedAt) - new Date(a.askedAt)));
    } catch (err) { errorResponse(res, 500, err.message); }
});

// S12 — 48h unanswered question sweep: runs every hour, nudges seller once per question
setInterval(async () => {
    try {
        const cutoff = new Date(Date.now() - 48 * 60 * 60 * 1000);
        // Find products with open questions older than 48h that have not been nudged yet
        const products = await Product.find({
            'questions.status':    'open',
            'questions.nudgeSent': false,
            'questions.askedAt':   { $lt: cutoff }
        });
        for (const p of products) {
            const staleQuestions = p.questions.filter(
                q => q.status === 'open' && !q.nudgeSent && q.askedAt < cutoff
            );
            if (!staleQuestions.length) continue;
            for (const q of staleQuestions) {
                q.nudgeSent = true;
                bus.emit('product.question_unanswered', {
                    productId:  p._id,
                    sellerId:   p.sellerId,
                    questionId: q._id,
                    preview:    q.body.slice(0, 80)
                });
            }
            await p.save();
        }
    } catch (err) { console.error('[CATALOG] Q&A unanswered sweep error:', err.message); }
}, 60 * 60 * 1000); // every hour

// ── Admin Routes ─────────────────────────────────────────────────────────────

// PATCH /admin/products/:id/force-status — set any product status
app.patch('/admin/products/:id/force-status', async (req, res) => {
    if (req.user?.role !== 'admin') return errorResponse(res, 403, 'Admin only');
    const VALID = ['active', 'paused', 'archived', 'deleted', 'pending_review', 'rejected'];
    const { status, reason } = req.body;
    if (!VALID.includes(status)) return errorResponse(res, 400, `status must be one of: ${VALID.join(', ')}`);
    try {
        const p = await Product.findById(req.params.id);
        if (!p) return errorResponse(res, 404, 'Not found');
        p.status = status;
        if (status === 'rejected') {
            p.rejectionReason = (reason || '').trim();
            p.rejectionCount  = (p.rejectionCount || 0) + 1;
        }
        await p.save();
        bus.emit('product.status_forced', {
            productId: p._id,
            sellerId:  p.sellerId,
            status,
            reason:    reason || '',
            adminId:   req.user.sub || req.user.email
        });
        res.json(p);
    } catch (err) { errorResponse(res, 500, err.message); }
});

// GET /admin/products — full product list with admin filters
// Query: sellerId, status, category, page=1, limit=50
// NOTE: GET /products/pending-review already exists — this is the broader admin list
app.get('/admin/products', async (req, res) => {
    if (req.user?.role !== 'admin') return errorResponse(res, 403, 'Admin only');
    try {
        const { sellerId, status, category, page = 1, limit = 50 } = req.query;
        const query = {};
        if (sellerId) query.sellerId = sellerId;
        if (status)   query.status   = status;
        if (category) query.category = category;
        const skip = (parseInt(page) - 1) * parseInt(limit);
        const lim  = Math.min(parseInt(limit), 200);
        const [products, total] = await Promise.all([
            Product.find(query).sort({ createdAt: -1 }).skip(skip).limit(lim),
            Product.countDocuments(query)
        ]);
        res.json({ products, total });
    } catch (err) { errorResponse(res, 500, err.message); }
});

// GET /admin/products/stale — active products with no orders in 90 days (updatedAt as proxy)
app.get('/admin/products/stale', async (req, res) => {
    if (req.user?.role !== 'admin') return errorResponse(res, 403, 'Admin only');
    try {
        const cutoff = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000);
        const products = await Product.find({ status: 'active', createdAt: { $lt: cutoff } });
        res.json({ products, total: products.length });
    } catch (err) { errorResponse(res, 500, err.message); }
});



app.listen(process.env.PORT || 5002, () => console.log(`Catalog Service on port ${process.env.PORT || 5002}`));
