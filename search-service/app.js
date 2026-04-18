require('dotenv').config({ path: require('path').join(__dirname, '.env') });
const express  = require('express');
const mongoose = require('mongoose');
const cors     = require('cors');
const crypto   = require('crypto');
const errorResponse = require('../shared/utils/errorResponse');
const parseUser     = require('../shared/middleware/parseUser');
const platformGuard = require('../shared/middleware/platformGuard');
const bus           = require('../shared/eventBus');

const app = express();
app.use(express.json());
app.use(cors());
app.use(parseUser); // needed for admin scope checks on /health and /analytics/queries
app.use(platformGuard);

const db = mongoose.createConnection(process.env.MONGODB_URI);
db.on('connected', () => console.log('Search DB Connected'));
db.on('error',     (err) => console.error('[SEARCH] DB error:', err.message));

// ── S1: Schemas ──────────────────────────────────────────────────────────────

const SearchIndexSchema = new mongoose.Schema({
    // Core identity
    productId:          { type: mongoose.Schema.Types.ObjectId, required: true, unique: true },
    sellerId:           { type: mongoose.Schema.Types.ObjectId },

    // Text fields (all contribute to text composite)
    title:              String,
    description:        String,         // R3 — from product.created/updated payload
    category:           String,
    storeName:          String,         // C18 / C5 — from store.updated event

    // Text composite: title + category + description + storeName (all normalized at write time)
    text:               String,

    // Pricing
    price:              Number,
    originalPrice:      Number,         // C15 / R8 — from discount payload
    onSale:             Boolean,        // C15 / R8 — computed: price < originalPrice

    // Scores
    rating:             { type: Number, default: 0 },
    reviewCount:        { type: Number, default: 0 },
    velocityScore:      { type: Number, default: 0.0 },
    qualityScore:       { type: Number, default: 100 },

    // Seller reputation (R12)
    sellerRating:       { type: Number, default: 0 },
    sellerReviewCount:  { type: Number, default: 0 },

    // Availability (R2)
    inventoryLevel:     { type: Number, default: 0 },
    inventoryAvailable: { type: Boolean, default: true },

    // Visibility & status — 'active' | 'hidden' | 'deleted'
    status:             { type: String, default: 'active' },
    storeActive:        { type: Boolean, default: true },   // R1 — from seller.deactivated/reactivated

    // Temporal (R11)
    listedAt:           { type: Date },

    // Promoted listings (C11)
    featured:           { type: Boolean, default: false },
    featuredBoost:      { type: Number,  default: 0 },

    // Seller search fields (C5)
    storeDescription:   String,
});

// Text search — richer composite (title + category + description + storeName)
SearchIndexSchema.index({ text: 'text' });
// Compound filter indexes — always paired with { status:'active', storeActive:true }
SearchIndexSchema.index({ category: 1, price: 1 });
SearchIndexSchema.index({ status: 1, storeActive: 1, velocityScore: -1, qualityScore: -1 });
SearchIndexSchema.index({ status: 1, storeActive: 1, rating: -1 });
SearchIndexSchema.index({ status: 1, storeActive: 1, listedAt: -1 });
SearchIndexSchema.index({ status: 1, storeActive: 1, sellerRating: -1 });
SearchIndexSchema.index({ status: 1, storeActive: 1, inventoryAvailable: 1 });
SearchIndexSchema.index({ status: 1, storeActive: 1, onSale: 1, price: 1 });
SearchIndexSchema.index({ sellerId: 1, status: 1 }); // bulk update on seller.deactivated

const SearchIndex = db.model('SearchIndex', SearchIndexSchema);

// SearchLog — separate collection, 90-day TTL, never joined with product data (C8)
const SearchLogSchema = new mongoose.Schema({
    query:             String,
    normalizedQuery:   String,
    resultCount:       Number,
    category:          String,
    filters:           mongoose.Schema.Types.Mixed,
    sort:              String,
    page:              Number,
    sessionId:         String,  // SHA256(ip+ua+floor(Date.now()/3600000)).slice(0,16) — hour granularity
    timestamp:         { type: Date, default: Date.now, expires: 60 * 60 * 24 * 90 },
    clicked:           { type: Boolean, default: false },
    clickedProductId:  mongoose.Schema.Types.ObjectId,
    clickPosition:     Number,
    sellerIds:         [mongoose.Schema.Types.ObjectId], // C19 — populated on /sellers only
});
// No explicit index needed, 'expires' property creates a TTL index.
// SearchLogSchema.index({ timestamp: 1 });
SearchLogSchema.index({ normalizedQuery: 1, timestamp: -1 });
SearchLogSchema.index({ resultCount: 1, timestamp: -1 });

const SearchLog = db.model('SearchLog', SearchLogSchema);

// ── S2: Query normalization pipeline ────────────────────────────────────────

const STOPWORDS = new Set([
    'the','a','an','in','of','for','with','from','by','on','at','to',
    'is','it','this','and','or','but','that','was','are','be','i','me','my'
]);

function normalize(q) {
    if (!q || typeof q !== 'string') return '';
    return q.toLowerCase()
        .replace(/[^a-z0-9\s]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .split(' ')
        .filter(w => w.length > 1 && !STOPWORDS.has(w))
        .join(' ');
}

// Applied symmetrically at write time and query time
function buildTextComposite(title, category, description, storeName) {
    return normalize([title, category, description, storeName].filter(Boolean).join(' '));
}

// ── S7: LRU Cache with reverse index (C3) ───────────────────────────────────

// KNOWN CONSTRAINT: in-process only — no persistence across restarts, no cross-instance sharing.
// Effective for single-process dev/docker environment. Replace with Redis at scale.

class LRUCache {
    constructor(maxSize, ttlMs) {
        this.maxSize     = maxSize;
        this.ttlMs       = ttlMs;
        this.cache       = new Map();                        // key → { value, expiresAt, productIds }
        this.reverseIndex = new Map();                       // productId → Set<key>
    }

    _evict(key) {
        const entry = this.cache.get(key);
        if (!entry) return;
        // Remove from reverse index
        for (const pid of (entry.productIds || [])) {
            const keys = this.reverseIndex.get(pid);
            if (keys) { keys.delete(key); if (keys.size === 0) this.reverseIndex.delete(pid); }
        }
        this.cache.delete(key);
    }

    set(key, value, productIds = []) {
        // Evict existing entry for this key if present
        if (this.cache.has(key)) this._evict(key);
        // LRU eviction: if at capacity, remove oldest (first inserted) entry
        if (this.cache.size >= this.maxSize) {
            this._evict(this.cache.keys().next().value);
        }
        const entry = { value, expiresAt: Date.now() + this.ttlMs, productIds };
        this.cache.set(key, entry);
        // Populate reverse index
        for (const pid of productIds) {
            if (!this.reverseIndex.has(pid)) this.reverseIndex.set(pid, new Set());
            this.reverseIndex.get(pid).add(key);
        }
    }

    get(key) {
        const entry = this.cache.get(key);
        if (!entry) return null;
        if (Date.now() > entry.expiresAt) { this._evict(key); return null; }
        // LRU refresh: move to end by re-inserting
        this.cache.delete(key);
        this.cache.set(key, entry);
        return entry.value;
    }

    // Evict all cache entries that contain a specific productId (via reverse index)
    evictByProductId(productId) {
        const pid = productId.toString();
        const keys = this.reverseIndex.get(pid);
        if (!keys) return;
        for (const key of [...keys]) this._evict(key);
    }

    // Full flush — used on seller.deactivated (storeActive is a global correctness filter)
    flush() {
        this.cache.clear();
        this.reverseIndex.clear();
    }

    size() { return this.cache.size; }
}

const lru = new LRUCache(200, 60 * 1000); // 200 entries, 60-second TTL

// Separate 5-minute TTL cache for /related (keyed by productId)
const relatedLru = new LRUCache(500, 5 * 60 * 1000);

// ── S9: Autocomplete in-memory title Set (C4) ────────────────────────────────

// Hydration state: false until first successful DB query
let titleSetHydrated = false;
const titleSet = new Map(); // productId.toString() → { title, productId, category }
let lastEventAt = null; // for /health

const RETRY_DELAYS = [5000, 15000, 30000, 60000, 120000];

async function hydrateTitleSet(attempt = 0) {
    try {
        const docs = await SearchIndex.find(
            { status: 'active', storeActive: true },
            'title productId category'
        ).lean();
        if (docs.length === 0 && attempt < RETRY_DELAYS.length) {
            // MongoDB not ready yet — schedule retry
            setTimeout(() => hydrateTitleSet(attempt + 1), RETRY_DELAYS[attempt]);
            console.log(`[SEARCH] Title set hydration: 0 results, retry in ${RETRY_DELAYS[attempt]}ms (attempt ${attempt + 1})`);
            return;
        }
        titleSet.clear();
        for (const d of docs) titleSet.set(d.productId.toString(), { title: d.title || '', productId: d.productId, category: d.category || '' });
        titleSetHydrated = docs.length > 0;
        if (titleSetHydrated) console.log(`[SEARCH] Title set hydrated: ${titleSet.size} entries`);
        else console.error('[SEARCH] Title set: all retry attempts exhausted — /suggest returns empty until restart');
    } catch (err) {
        if (attempt < RETRY_DELAYS.length) {
            setTimeout(() => hydrateTitleSet(attempt + 1), RETRY_DELAYS[attempt]);
            console.error(`[SEARCH] Title set hydration error: ${err.message} — retry in ${RETRY_DELAYS[attempt]}ms`);
        } else {
            console.error('[SEARCH] Title set: all retry attempts exhausted —', err.message);
        }
    }
}

// Prefix match for autocomplete
function prefixMatch(q, maxProducts = 5, maxCategories = 3) {
    if (!titleSetHydrated) return { products: [], categories: [] };
    const nq = normalize(q);
    if (!nq || nq.length < 2) return { products: [], categories: [] };

    const matchedProducts = [];
    const matchedCategories = new Set();

    for (const [, item] of titleSet) {
        const titleNorm = normalize(item.title);
        if (titleNorm.startsWith(nq) || titleNorm.includes(nq)) {
            if (matchedProducts.length < maxProducts) matchedProducts.push({ title: item.title, productId: item.productId, category: item.category });
        }
        if (item.category && normalize(item.category).startsWith(nq)) matchedCategories.add(item.category);
        if (matchedProducts.length >= maxProducts && matchedCategories.size >= maxCategories) break;
    }

    return { products: matchedProducts, categories: [...matchedCategories].slice(0, maxCategories) };
}

// ── C1: Field-weighted relevance rerank ──────────────────────────────────────

function rerank(results, normalizedQuery) {
    if (!normalizedQuery || !results.length) return results;
    const tokens = normalizedQuery.split(' ').filter(Boolean);
    const phrase = normalizedQuery;

    const scored = results.map(r => {
        const titleLower = normalize(r.title || '');
        let bonus = 0;
        if (phrase && titleLower === phrase)                          bonus = 120; // exact title match
        else if (phrase && titleLower.includes(phrase))              bonus = 100; // phrase in title
        else if (tokens.every(t => titleLower.includes(t)))          bonus =  60; // all tokens in title
        else if (tokens.some(t => titleLower.includes(t)))           bonus =  20; // any token in title
        // no bonus if match is only in description
        return { _d: r, _score: (r.score || r._score || 0) + bonus };
    });

    scored.sort((a, b) => b._score - a._score);
    return scored.map(s => s._d);
}

// ── C12: Seller diversity cap ────────────────────────────────────────────────

// Applies to full returned page (not just top 10) — prevents monopolization by prolific sellers
function sellerDiversityCap(results, maxPerSeller = 3) {
    const counts = {};
    const main = [], deferred = [];
    for (const r of results) {
        const sid = (r.sellerId || '').toString();
        counts[sid] = (counts[sid] || 0) + 1;
        if (counts[sid] <= maxPerSeller) main.push(r);
        else deferred.push(r);
    }
    return [...main, ...deferred];
}

// ── C16: Levenshtein-based "did you mean" ────────────────────────────────────

// KNOWN CONSTRAINT: fuzzy matching only runs on zero-result queries.
// Full live-result typo tolerance requires Atlas Search or Elasticsearch (deferred per spec).

function levenshtein(a, b) {
    const m = a.length, n = b.length;
    const dp = Array.from({ length: m + 1 }, (_, i) =>
        Array.from({ length: n + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0))
    );
    for (let i = 1; i <= m; i++)
        for (let j = 1; j <= n; j++)
            dp[i][j] = a[i - 1] === b[j - 1]
                ? dp[i - 1][j - 1]
                : 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
    return dp[m][n];
}

const KNOWN_CATEGORIES = [
    'Electronics','Clothing','Shoes','Jewelry','Home & Garden','Sports & Outdoors',
    'Books','Toys & Games','Beauty','Health','Automotive','Food & Grocery',
    'Art & Crafts','Music','Pet Supplies','Office','Tools','Baby','Handmade','Vintage'
];

function buildZeroResultSuggestions(normalizedQuery) {
    if (!normalizedQuery) return { didYouMean: [], tryBrowsing: KNOWN_CATEGORIES.slice(0, 5) };
    const suggestions = [];
    for (const [, item] of titleSet) {
        const titleNorm = normalize(item.title || '');
        if (!titleNorm) continue;
        const dist = levenshtein(normalizedQuery, titleNorm.slice(0, normalizedQuery.length + 3));
        if (dist <= 2 && suggestions.indexOf(item.title) === -1) {
            suggestions.push(item.title);
            if (suggestions.length >= 3) break;
        }
    }
    return { didYouMean: suggestions, tryBrowsing: KNOWN_CATEGORIES.slice(0, 5) };
}

// ── C8: SearchLog write (fire-and-forget) ────────────────────────────────────

// Routes that write: GET /, GET /browse, GET /sellers
// Routes that do NOT write: suggest, related, click, health, analytics/queries
// See design decision table in build plan.

function sessionId(req) {
    const ip   = req.ip || req.connection?.remoteAddress || 'x';
    const ua   = req.headers['user-agent'] || 'x';
    const hour = Math.floor(Date.now() / 3600000); // hour granularity — avoids midnight split
    return crypto.createHash('sha256').update(ip + ua + hour).digest('hex').slice(0, 16);
}

function writeSearchLog(data) {
    setImmediate(() => {
        SearchLog.create(data).catch(err => console.error('[SEARCH] SearchLog write error:', err.message));
    });
}

// ── Mandatory base filter — applied to every search query, never skippable ──

const BASE_FILTER = { status: 'active', storeActive: true };

// ── S3 + S4: Event listeners ─────────────────────────────────────────────────

// NOTE on S3/S4 upstream dependencies:
// seller.deactivated, seller.reactivated, store.updated — seller-service must emit (Part 5).
// inventory.updated — inventory-service must emit (Part 5).
// product.flagged — catalog-service must emit (Part 5).
// product.featured — catalog-service must emit (Part 5).
// product.created/updated payloads — catalog-service must include description, createdAt, discount, storeName.
// Listeners below are wired and ready. End-to-end verification deferred until upstream emissions confirmed.

bus.on('product.created', async (p) => {
    try {
        lastEventAt = new Date();
        const discount   = p.discount || {};
        const onSale     = discount.enabled && discount.discountedPrice < p.price;
        const textComposite = buildTextComposite(p.title, p.category, p.description, p.storeName);
        await SearchIndex.create({
            productId:    p.productId,
            sellerId:     p.sellerId,
            title:        p.title,
            description:  p.description  || '',
            category:     p.category,
            storeName:    p.storeName    || '',
            storeDescription: p.storeDescription || '',
            text:         textComposite,
            price:        p.price,
            originalPrice: discount.enabled ? p.price : undefined,
            onSale:       !!onSale,
            listedAt:     p.createdAt   ? new Date(p.createdAt) : new Date(),
            status:       'hidden', // new listings start hidden; set active on approval event
            storeActive:  true,
        });
        // Refresh autocomplete title Set (append only — no full rebuild)
        if (p.productId) titleSet.set(p.productId.toString(), { title: p.title || '', productId: p.productId, category: p.category || '' });
        if (!titleSetHydrated && titleSet.size > 0) titleSetHydrated = true;
    } catch (err) {
        if (err.code !== 11000) console.error('[SEARCH] product.created error:', err.message);
    }
});

bus.on('product.updated', async (p) => {
    try {
        lastEventAt = new Date();
        const discount = p.discount || {};
        const onSale   = discount.enabled && discount.discountedPrice && discount.discountedPrice < p.price;
        const updateFields = {};
        if (p.title    !== undefined) updateFields.title    = p.title;
        if (p.category !== undefined) updateFields.category = p.category;
        if (p.price    !== undefined) updateFields.price    = p.price;
        // displayStatus is authoritative for search visibility; p.status handles deletion only
        if (p.displayStatus !== undefined) {
            updateFields.status = p.displayStatus === 'visible' ? 'active' : 'hidden';
        } else if (p.status !== undefined) {
            updateFields.status = p.status === 'deleted' ? 'deleted' : p.status === 'active' ? 'active' : 'hidden';
        }
        if (p.description  !== undefined) updateFields.description  = p.description;
        if (p.storeName    !== undefined) updateFields.storeName    = p.storeName;
        if (discount.enabled !== undefined) {
            updateFields.onSale       = !!onSale;
            updateFields.originalPrice = p.price;
        }
        // Rebuild text composite with all available fields
        const existing = await SearchIndex.findOne({ productId: p.productId }).lean();
        updateFields.text = buildTextComposite(
            p.title    || existing?.title,
            p.category || existing?.category,
            p.description !== undefined ? p.description : existing?.description,
            p.storeName   !== undefined ? p.storeName   : existing?.storeName
        );
        await SearchIndex.updateOne({ productId: p.productId }, updateFields);
        // Update title Set
        if (p.productId) titleSet.set(p.productId.toString(), { title: p.title || '', productId: p.productId, category: p.category || '' });
        // Cache invalidation via reverse index — evict only entries containing this product
        lru.evictByProductId(p.productId);
    } catch (err) { console.error('[SEARCH] product.updated error:', err.message); }
});

bus.on('user.deleted', async (payload) => {
    try {
        lastEventAt = new Date();
        const sellerId = payload.storeId || payload.userId;
        // Collect productIds before bulk delete so we can evict title set entries
        const records = await SearchIndex.find({ sellerId }, 'productId').lean();
        await SearchIndex.deleteMany({ sellerId });
        records.forEach(r => titleSet.delete(r.productId.toString()));
        lru.flush(); // user deletion is rare — full flush is acceptable
        console.log(`[SEARCH] Purged ${records.length} index records for seller ${sellerId}`);
    } catch (err) { console.error('[SEARCH] user.deleted cleanup error:', err.message); }
});

bus.on('product.deleted', async (p) => {
    try {
        lastEventAt = new Date();
        await SearchIndex.updateOne({ productId: p.productId }, { status: 'deleted' });
        // Remove from title Set
        if (p.productId) titleSet.delete(p.productId.toString());
        lru.evictByProductId(p.productId);
    } catch (err) { console.error('[SEARCH] product.deleted error:', err.message); }
});

bus.on('review.approved', async (r) => {
    try {
        lastEventAt = new Date();
        await SearchIndex.updateOne({ productId: r.productId }, { rating: r.avgRating || r.rating });
        lru.evictByProductId(r.productId);
    } catch (err) { console.error('[SEARCH] review.approved error:', err.message); }
});

bus.on('review.submitted', async (r) => {
    try {
        lastEventAt = new Date();
        await SearchIndex.updateOne({ productId: r.productId }, { rating: r.avgRating, reviewCount: r.reviewCount });
        lru.evictByProductId(r.productId);
    } catch (err) { console.error('[SEARCH] review.submitted error:', err.message); }
});

// S3 — NEW: seller reputation from review-service (event already emitted after Phase 3)
bus.on('seller.reviewed', async (r) => {
    try {
        lastEventAt = new Date();
        // Update sellerRating + sellerReviewCount on ALL products from this seller
        await SearchIndex.updateMany(
            { sellerId: r.sellerId },
            { sellerRating: r.avgRating || 0, sellerReviewCount: r.reviewCount || 0 }
        );
        console.log(`[SEARCH] sellerRating updated for seller ${r.sellerId}: ${r.avgRating}`);
    } catch (err) { console.error('[SEARCH] seller.reviewed error:', err.message); }
});

bus.on('product.metrics_updated', async (p) => {
    try {
        lastEventAt = new Date();
        await SearchIndex.updateOne({ productId: p.productId }, { velocityScore: p.velocityScore, qualityScore: p.qualityScore });
        // Per-product invalidation via reverse index — does NOT flush entire cache
        lru.evictByProductId(p.productId);
    } catch (err) { console.error('[SEARCH] product.metrics_updated error:', err.message); }
});

// S3 — NEW: seller deactivation (seller-service must emit — Part 5)
// UPSTREAM DEPENDENCY: seller-service.PUT /:storeId must emit seller.deactivated when active → false
bus.on('seller.deactivated', async (payload) => {
    try {
        lastEventAt = new Date();
        await SearchIndex.updateMany({ sellerId: payload.sellerId }, { storeActive: false });
        // Full cache flush — storeActive is a global correctness filter; partial invalidation not safe
        lru.flush();
        console.log(`[SEARCH] seller.deactivated: all products hidden for seller ${payload.sellerId}`);
    } catch (err) { console.error('[SEARCH] seller.deactivated error:', err.message); }
});

// S3 — NEW: seller reactivation (seller-service must emit — Part 5)
bus.on('seller.reactivated', async (payload) => {
    try {
        lastEventAt = new Date();
        await SearchIndex.updateMany({ sellerId: payload.sellerId }, { storeActive: true });
        lru.flush(); // storeActive changed globally — full flush required
        console.log(`[SEARCH] seller.reactivated: products restored for seller ${payload.sellerId}`);
    } catch (err) { console.error('[SEARCH] seller.reactivated error:', err.message); }
});

// S4 — NEW: store name/description changed (seller-service must emit — Part 5)
bus.on('store.updated', async (payload) => {
    try {
        lastEventAt = new Date();
        const update = {};
        if (payload.storeName        !== undefined) update.storeName        = payload.storeName;
        if (payload.storeDescription !== undefined) update.storeDescription = payload.storeDescription;
        if (Object.keys(update).length === 0) return;
        // Rebuild text for all products by this seller
        const products = await SearchIndex.find({ sellerId: payload.sellerId }).lean();
        for (const p of products) {
            const newText = buildTextComposite(p.title, p.category, p.description, payload.storeName || p.storeName);
            await SearchIndex.updateOne({ productId: p.productId }, { $set: { ...update, text: newText } });
        }
        console.log(`[SEARCH] store.updated: storeName synced for ${products.length} products of seller ${payload.sellerId}`);
    } catch (err) { console.error('[SEARCH] store.updated error:', err.message); }
});

// S3 — NEW: inventory changes (inventory-service must emit — Part 5)
bus.on('inventory.updated', async (payload) => {
    try {
        lastEventAt = new Date();
        const available = (payload.available !== undefined)
            ? payload.available
            : (payload.quantity || 0) - (payload.reserved || 0);
        await SearchIndex.updateOne(
            { productId: new (require('mongoose').Types.ObjectId)(payload.productId) },
            { $set: { inventoryLevel: available, inventoryAvailable: available > 0 } }
        );
        // Per-product invalidation — inStock filter results may change
        lru.evictByProductId(payload.productId);
    } catch (err) { console.error('[SEARCH] inventory.updated error:', err.message); }
});

// S3 — NEW: admin-flagged products (catalog-service must emit — Part 5)
bus.on('product.flagged', async (payload) => {
    try {
        lastEventAt = new Date();
        await SearchIndex.updateOne({ productId: payload.productId }, { status: 'hidden' });
        // status: 'hidden' excluded by BASE_FILTER — product disappears immediately
        lru.evictByProductId(payload.productId);
        console.log(`[SEARCH] product.flagged: product ${payload.productId} hidden from search`);
    } catch (err) { console.error('[SEARCH] product.flagged error:', err.message); }
});

// S15 — NEW: seller promotes listing (catalog-service must emit — Part 5)
bus.on('product.featured', async (payload) => {
    try {
        lastEventAt = new Date();
        await SearchIndex.updateOne(
            { productId: payload.productId },
            { featured: !!payload.featured, featuredBoost: payload.featured ? 1 : 0 }
        );
        lru.evictByProductId(payload.productId);
    } catch (err) { console.error('[SEARCH] product.featured error:', err.message); }
});

// S17 — Feedback loop listener stub (C13) — emitter not yet built in analytics-service
// Event contract: { productId, boost: Number }
bus.on('search.click_signal', async (payload) => {
    try {
        await SearchIndex.updateOne(
            { productId: payload.productId },
            { $inc: { qualityScore: payload.boost || 1 } }
        );
    } catch (err) { console.error('[SEARCH] search.click_signal error:', err.message); }
});

// ── Startup: hydrate title Set after DB connects ──────────────────────────────

db.on('connected', () => {
    // Slight delay to ensure model registration completes
    setTimeout(() => hydrateTitleSet(0), 500);
});

// ── S5: GET / — Main search (enhanced) ──────────────────────────────────────

app.get('/', async (req, res) => {
    try {
        const {
            q, category, minPrice, maxPrice,
            minSellerRating, minReviewCount,
            inStock, onSale, newArrivals,
            sort, page = 1, limit = 20
        } = req.query;

        const nq   = normalize(q);
        const skip = (Math.max(parseInt(page), 1) - 1) * Math.min(parseInt(limit), 50);
        const lim  = Math.min(parseInt(limit) || 20, 50);

        // Cache key — must include ALL filter params
        const cacheKey = `search:${nq}:${category||''}:${minPrice||''}:${maxPrice||''}:${minSellerRating||''}:${minReviewCount||''}:${inStock||''}:${onSale||''}:${newArrivals||''}:${sort||''}:${page}:${lim}`;
        const cached = lru.get(cacheKey);
        if (cached) return res.json(cached);

        // Build query — mandatory base filter always applied
        const query = { ...BASE_FILTER };
        if (nq)            query.$text = { $search: nq };
        if (category)      query.category = category;
        if (minPrice || maxPrice) {
            query.price = {};
            if (minPrice) query.price.$gte = Number(minPrice);
            if (maxPrice) query.price.$lte = Number(maxPrice);
        }
        if (minSellerRating)  query.sellerRating  = { $gte: Number(minSellerRating) };
        if (minReviewCount)   query.reviewCount   = { $gte: Number(minReviewCount) };
        if (inStock === 'true')  query.inventoryAvailable = true;
        if (onSale  === 'true')  query.onSale = true;
        if (newArrivals) query.listedAt = { $gte: new Date(Date.now() - Number(newArrivals) * 86400000) };

        // Sort logic — R7: textScore when q present, best_match composite when absent
        let sortObj = {};
        const projection = {};
        const isKeyword = !!nq;

        if (sort === 'relevance' || (!sort && isKeyword)) {
            sortObj     = { score: { $meta: 'textScore' } };
            projection.score = { $meta: 'textScore' };
        } else if (sort === 'trending') {
            sortObj = { velocityScore: -1 };
        } else if (sort === 'top_rated') {
            query.reviewCount = { ...(query.reviewCount || {}), $gte: Math.max(Number(minReviewCount) || 0, 3) };
            sortObj = { rating: -1, reviewCount: -1 };
        } else if (sort === 'most_reviewed') {
            sortObj = { reviewCount: -1 };
        } else if (sort === 'price_asc') {
            sortObj = { price: 1 };
        } else if (sort === 'price_desc') {
            sortObj = { price: -1 };
        } else if (sort === 'newest') {
            sortObj = { listedAt: -1 };
        } else {
            // best_match — multi-field composite approximation
            sortObj = { qualityScore: -1, velocityScore: -1, rating: -1 };
        }

        const [results, totalCount] = await Promise.all([
            SearchIndex.find(query, projection).sort(sortObj).skip(skip).limit(lim).lean(),
            SearchIndex.countDocuments(query)
        ]);

        // S6: Field-weighted rerank (only when keyword present)
        let finalResults = isKeyword ? rerank(results, nq) : results;

        // S16: Seller diversity cap — keyword search only, full page
        if (isKeyword) finalResults = sellerDiversityCap(finalResults);

        const productIds = finalResults.map(r => r.productId);

        const envelope = {
            results:    finalResults,
            totalCount,
            page:       parseInt(page),
            limit:      lim,
            hasMore:    totalCount > skip + lim,
            query:      nq || '',
        };

        // R10: Zero-results suggestions (C16)
        if (totalCount === 0) {
            envelope.suggestions = buildZeroResultSuggestions(nq);
        }

        // S7: Cache the result with reverse index for per-product invalidation
        lru.set(cacheKey, envelope, productIds);

        // S8: SearchLog write — fire-and-forget, does not block response
        writeSearchLog({
            query: q || '', normalizedQuery: nq, resultCount: totalCount,
            category: category || null, filters: { minPrice, maxPrice, minSellerRating, minReviewCount, inStock, onSale, newArrivals },
            sort: sort || (isKeyword ? 'relevance' : 'best_match'),
            page: parseInt(page), sessionId: sessionId(req), timestamp: new Date()
        });

        res.json(envelope);
    } catch (err) { errorResponse(res, 500, err.message); }
});

// ── S9: GET /suggest — Autocomplete (C4) ────────────────────────────────────

app.get('/suggest', (req, res) => {
    // This endpoint must NEVER hit MongoDB
    // Returns empty arrays while hydrated === false (cold start)
    const { q } = req.query;
    if (!q || q.length < 2) return res.json({ products: [], categories: [] });
    res.json(prefixMatch(q));
});

// ── S10: GET /browse — Category browse (C6) ─────────────────────────────────

app.get('/browse', async (req, res) => {
    try {
        const { category, sort, page = 1, limit = 20 } = req.query;
        const skip = (Math.max(parseInt(page), 1) - 1) * Math.min(parseInt(limit), 50);
        const lim  = Math.min(parseInt(limit) || 20, 50);

        // No 'q' param — this is discovery mode, not keyword mode
        // textScore is NOT requested — it has no meaning without a query
        const match = { ...BASE_FILTER };
        if (category) match.category = category;

        // Best-match composite sort with featured boost
        // Formula: (qualityScore * 0.4 + velocityScore * 0.4 + rating * 4) * (1 + featuredBoost * 0.5)
        // rating scaled to 0-100 range: rating * 20, then * 0.2 weight = rating * 4
        const pipeline = [
            { $match: match },
            { $addFields: {
                _compositeScore: {
                    $multiply: [
                        { $add: [
                            { $multiply: ['$qualityScore',  0.4] },
                            { $multiply: ['$velocityScore', 0.4] },
                            { $multiply: ['$rating',        4.0] }
                        ]},
                        { $add: [1, { $multiply: ['$featuredBoost', 0.5] }] }
                    ]
                }
            }},
        ];

        let sortStage;
        if (sort === 'trending')   sortStage = { velocityScore: -1 };
        else if (sort === 'top_rated') sortStage = { rating: -1, reviewCount: -1 };
        else if (sort === 'newest')    sortStage = { listedAt: -1 };
        else                           sortStage = { _compositeScore: -1 }; // best_match default

        pipeline.push({ $sort: sortStage });

        const [results, totalDocs] = await Promise.all([
            SearchIndex.aggregate([...pipeline, { $skip: skip }, { $limit: lim }]),
            SearchIndex.countDocuments(match)
        ]);

        const envelope = {
            results, totalCount: totalDocs, page: parseInt(page), limit: lim,
            hasMore: totalDocs > skip + lim
        };

        // S8: SearchLog write for browse (category browsing is analytics signal)
        writeSearchLog({
            query: '', normalizedQuery: '', resultCount: totalDocs,
            category: category || null, filters: { sort },
            sort: sort || 'best_match', page: parseInt(page),
            sessionId: sessionId(req), timestamp: new Date()
        });

        res.json(envelope);
    } catch (err) { errorResponse(res, 500, err.message); }
});

// ── S11: GET /sellers — Seller search (C5) ───────────────────────────────────

app.get('/sellers', async (req, res) => {
    try {
        const { q, category, minRating } = req.query;
        const nq = normalize(q);

        const match = { ...BASE_FILTER };
        if (category)  match.category    = category;
        if (minRating) match.sellerRating = { $gte: Number(minRating) };
        // Text match on storeName/storeDescription handled via text index when q present
        if (nq) match.$text = { $search: nq };

        const pipeline = [
            { $match: match },
            { $group: {
                _id:              '$sellerId',
                storeName:        { $first: '$storeName' },
                storeDescription: { $first: '$storeDescription' },
                sellerRating:     { $first: '$sellerRating' },
                sellerReviewCount:{ $first: '$sellerReviewCount' },
                totalProducts:    { $sum: 1 }
            }},
            { $sort: { sellerRating: -1, totalProducts: -1 } },
            { $limit: 20 }
        ];

        const sellers = await SearchIndex.aggregate(pipeline);
        const sellerIds = sellers.map(s => s._id).filter(Boolean);

        // S8: SearchLog write with sellerIds (C19 — seller discovery logging)
        writeSearchLog({
            query: q || '', normalizedQuery: nq, resultCount: sellers.length,
            category: category || null, filters: { minRating },
            sort: 'sellerRating', page: 1, sessionId: sessionId(req),
            timestamp: new Date(), sellerIds
        });

        res.json(sellers.map(s => ({
            sellerId:         s._id,
            storeName:        s.storeName        || '',
            storeDescription: s.storeDescription || '',
            sellerRating:     s.sellerRating     || 0,
            sellerReviewCount:s.sellerReviewCount || 0,
            totalProducts:    s.totalProducts    || 0
        })));
    } catch (err) { errorResponse(res, 500, err.message); }
});

// ── S12: GET /related — Related products (C7) ────────────────────────────────

app.get('/related', async (req, res) => {
    try {
        const { productId, limit = 6 } = req.query;
        if (!productId) return errorResponse(res, 400, 'productId required');

        const lim = Math.min(parseInt(limit) || 6, 12);
        const cacheKey = `related:${productId}:${lim}`;
        const cached = relatedLru.get(cacheKey);
        if (cached) return res.json(cached);

        // Fetch target product's category and sellerId
        const target = await SearchIndex.findOne({ productId }).lean();
        if (!target) return res.json({ results: [], totalCount: 0, page: 1, limit: lim, hasMore: false });

        const results = await SearchIndex.find({
            ...BASE_FILTER,
            category:  target.category,
            sellerId:  { $ne: target.sellerId },   // cross-seller discovery
            productId: { $ne: target.productId },  // exclude self
        })
        .sort({ velocityScore: -1, qualityScore: -1 })
        .limit(lim)
        .lean();

        const envelope = { results, totalCount: results.length, page: 1, limit: lim, hasMore: false };
        // 5-minute TTL cache per productId (slow-moving data)
        relatedLru.set(cacheKey, envelope, [productId]);
        res.json(envelope);
    } catch (err) { errorResponse(res, 500, err.message); }
});

// ── S13: POST /click — Click tracking (C9) ──────────────────────────────────

app.post('/click', async (req, res) => {
    // Click tracking must never block or error-out the frontend
    const { searchLogId, productId, position } = req.body;
    if (searchLogId) {
        setImmediate(() => {
            SearchLog.findByIdAndUpdate(searchLogId, {
                clicked: true,
                clickedProductId: productId,
                clickPosition:    position
            }).catch(err => console.error('[SEARCH] click tracking error:', err.message));
        });
    }
    res.json({ ok: true });
});

// ── S14: GET /analytics/queries — Admin (C10) ────────────────────────────────

app.get('/analytics/queries', async (req, res) => {
    if (!req.user || !req.user.scopes?.includes('admin')) return errorResponse(res, 403, 'Admin scope required');
    try {
        const { startDate, endDate } = req.query;
        const dateFilter = {};
        if (startDate) dateFilter.$gte = new Date(startDate);
        if (endDate)   dateFilter.$lte = new Date(endDate);
        const matchStage = Object.keys(dateFilter).length ? { timestamp: dateFilter } : {};

        const [topQueries, zeroResults, byCategory] = await Promise.all([
            SearchLog.aggregate([
                { $match: { ...matchStage, normalizedQuery: { $ne: '' } } },
                { $group: {
                    _id:            '$normalizedQuery',
                    count:          { $sum: 1 },
                    avgResultCount: { $avg: '$resultCount' },
                    clickCount:     { $sum: { $cond: ['$clicked', 1, 0] } }
                }},
                { $project: {
                    query:             '$_id',
                    count:             1,
                    avgResultCount:    { $round: ['$avgResultCount', 1] },
                    clickThroughRate:  { $round: [{ $divide: ['$clickCount', '$count'] }, 3] }
                }},
                { $sort: { count: -1 } },
                { $limit: 20 }
            ]),
            SearchLog.aggregate([
                { $match: { ...matchStage, resultCount: 0, normalizedQuery: { $ne: '' } } },
                { $group: { _id: '$normalizedQuery', count: { $sum: 1 } } },
                { $project: { query: '$_id', count: 1 } },
                { $sort: { count: -1 } },
                { $limit: 20 }
            ]),
            SearchLog.aggregate([
                { $match: { ...matchStage, category: { $exists: true, $ne: null } } },
                { $group: { _id: '$category', avgResultCount: { $avg: '$resultCount' } } },
                { $project: { category: '$_id', avgResultCount: { $round: ['$avgResultCount', 1] } } },
                { $sort: { avgResultCount: -1 } }
            ])
        ]);

        const totalSearches = await SearchLog.countDocuments(matchStage);

        res.json({
            topQueries,
            zeroResultQueries:    zeroResults,
            avgResultsByCategory: byCategory,
            totalSearches,
            dateRange: { startDate: startDate || null, endDate: endDate || null }
        });
    } catch (err) { errorResponse(res, 500, err.message); }
});

// ── S14: GET /health — Admin index health (C14) ──────────────────────────────

app.get('/admin/health', async (req, res) => {
    if (!req.user || !req.user.scopes?.includes('admin')) return errorResponse(res, 403, 'Admin scope required');
    try {
        const [indexedCount, activeCount, hiddenCount, deletedCount] = await Promise.all([
            SearchIndex.countDocuments({}),
            SearchIndex.countDocuments({ status: 'active', storeActive: true }),
            SearchIndex.countDocuments({ status: 'hidden' }),
            SearchIndex.countDocuments({ status: 'deleted' })
        ]);

        // Drift detection — call catalog-service for its active product count
        let catalogCount = null, diverged = false;
        try {
            const catRes = await fetch('http://localhost:5002/products?limit=1');
            // Catalog doesn't expose a count endpoint — use a head count via its own DB
            // For now, use activeCount as a proxy and flag if searchIndex has hidden or drift
            // This is a best-effort drift check — replace with a dedicated /count endpoint if added to catalog
            catalogCount = null; // set to null until catalog exposes a count endpoint
        } catch (_) { /* catalog unreachable — drift unknown */ }

        if (catalogCount !== null) {
            const delta = Math.abs(activeCount - catalogCount);
            diverged = delta / Math.max(catalogCount, 1) > 0.1;
            if (diverged) {
                bus.emit('search.index_drift', { catalogCount, searchCount: activeCount, delta, timestamp: new Date() });
                console.warn(`[SEARCH] Index drift detected: catalog=${catalogCount}, search=${activeCount}`);
            }
        }

        res.json({
            indexedCount,
            activeCount,
            hiddenCount,
            deletedCount,
            lastEventAt,
            cacheEntries:      lru.size(),
            titleSetSize:      titleSet.size,
            titleSetHydrated,
            // KNOWN CONSTRAINTS — documented, not hidden (C16, C17)
            paginationMode:    'skip-limit',        // C17: cursor pagination required at scale
            typoTolerance:     'zero-results-only', // C16: full fuzzy matching requires Elasticsearch
            drift: {
                catalogCount,
                searchCount: activeCount,
                diverged
            }
        });
    } catch (err) { errorResponse(res, 500, err.message); }
});

// ── ADMIN ROUTES ──────────────────────────────────────────────────────────────
// All require: admin role (injected via x-user header by admin-service)

// GET /admin/index-health — index stats
app.get('/admin/index-health', async (req, res) => {
    if (!req.headers['x-admin-email'] && req.user?.role !== 'admin') return errorResponse(res, 403, 'Admin only');
    try {
        const pipeline = [
            { $group: { _id: '$status', count: { $sum: 1 } } }
        ];
        const [statusCounts, lastDoc] = await Promise.all([
            SearchIndex.aggregate(pipeline),
            SearchIndex.findOne({}, 'updatedAt').sort({ updatedAt: -1 }).lean()
        ]);
        const byStatus = {};
        let total = 0;
        for (const s of statusCounts) {
            byStatus[s._id || 'unknown'] = s.count;
            total += s.count;
        }
        res.json({ total, byStatus, lastUpdated: lastDoc?.updatedAt || null });
    } catch (err) { errorResponse(res, 500, err.message); }
});

// PATCH /admin/:productId/unhide — restore product to active in search
app.patch('/admin/:productId/unhide', async (req, res) => {
    if (!req.headers['x-admin-email'] && req.user?.role !== 'admin') return errorResponse(res, 403, 'Admin only');
    try {
        const result = await SearchIndex.findOneAndUpdate(
            { productId: req.params.productId },
            { status: 'active' },
            { new: true }
        );
        if (!result) return errorResponse(res, 404, 'Product not found in search index');
        lru.evictByProductId(req.params.productId);
        res.json({ success: true });
    } catch (err) { errorResponse(res, 500, err.message); }
});

// POST /admin/cache/clear — clear query cache
app.post('/admin/cache/clear', (req, res) => {
    if (!req.headers['x-admin-email'] && req.user?.role !== 'admin') return errorResponse(res, 403, 'Admin only');
    lru.flush();
    relatedLru.flush();
    res.json({ success: true, cleared: true });
});

// GET /admin/autocomplete — list autocomplete suggestions from in-memory title set
app.get('/admin/autocomplete', (req, res) => {
    if (!req.headers['x-admin-email'] && req.user?.role !== 'admin') return errorResponse(res, 403, 'Admin only');
    const terms = [];
    for (const [, item] of titleSet) {
        if (item.title) terms.push(item.title);
    }
    res.json({ terms, total: terms.length });
});

// DELETE /admin/autocomplete/:term — no separate autocomplete collection; return informational note
app.delete('/admin/autocomplete/:term', (req, res) => {
    if (!req.headers['x-admin-email'] && req.user?.role !== 'admin') return errorResponse(res, 403, 'Admin only');
    // Autocomplete is served from the in-memory titleSet (hydrated from SearchIndex).
    // There is no separate QueryLog or Autocomplete collection in this service.
    res.json({ success: true, note: 'no autocomplete collection' });
});

// POST /admin/reindex-all — mark all SearchIndex docs as stale for reindex
app.post('/admin/reindex-all', async (req, res) => {
    if (!req.headers['x-admin-email'] && req.user?.role !== 'admin') return errorResponse(res, 403, 'Admin only');
    try {
        const result = await SearchIndex.updateMany({}, { status: 'stale' });
        // Flush caches so stale entries are not served
        lru.flush();
        relatedLru.flush();
        res.json({ success: true, count: result.modifiedCount });
    } catch (err) { errorResponse(res, 500, err.message); }
});


app.get('/health', (req, res) => {
    res.json({ service: 'search-service', status: 'ok', dbState: db.readyState === 1 ? 'connected' : 'disconnected' });
});

app.listen(process.env.PORT || 5012, () => console.log(`Search Service on port ${process.env.PORT || 5012}`));
