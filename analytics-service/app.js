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
db.on('connected', () => console.log('Analytics DB Connected'));
db.on('error', (err) => console.error('[ANALYTICS] DB error:', err.message));

const MetricSchema = new mongoose.Schema({
    event:     { type: String, required: true, index: true },
    data:      mongoose.Schema.Types.Mixed,
    timestamp: { type: Date, default: Date.now, index: true }
});
const Metric = db.model('Metric', MetricSchema);

// ── Event listeners ──────────────────────────────────────────────────────────

const trackedEvents = [
    'order.placed', 'payment.captured', 'shipment.created',
    'shipment.delivered', 'product.created', 'review.approved',
    'inventory.stock_low', 'inventory.purchase_blocked',
    'cart.item_added', 'cart.item_removed', 'order.inventory_failed',
    // A.10: Review analytics
    'review.submitted', 'review.flagged', 'seller.replied', 'seller.reviewed',
    // Messaging analytics
    'message.seller_response',
    // Payment analytics (S5, S8, S9, S10, S11)
    'payment.collected', 'payment.auto_released', 'payment.disputed',
    'payment.refunded', 'payment.partial_refunded', 'payment.cod_expired',
    // Phase 8 — new event coverage
    'product.approved', 'product.rejected', 'product.question_asked',
    'inventory.restocked', 'order.reservation_expired', 'order.modified',
    'store.verified', 'store.vacation_started', 'store.vacation_ended',
    'seller.tier_updated'
];
trackedEvents.forEach(ev => {
    bus.on(ev, async (payload) => {
        try { await Metric.create({ event: ev, data: payload }); }
        catch {}
    });
});

// shipment.delivered — on-time rate, carrier breakdown, days-to-ship per seller (R8/S13)
bus.on('shipment.delivered', (payload) => {
    const { sellerId, carrier, onTime, createdAt, deliveredAt } = payload;
    if (!sellerId) return;
    const daysToShip = (createdAt && deliveredAt)
        ? Math.round((new Date(deliveredAt) - new Date(createdAt)) / 86400000 * 10) / 10
        : null;
    console.log(`[ANALYTICS] Delivery — seller: ${sellerId}, carrier: ${carrier || 'N/A'}, onTime: ${onTime}, daysToShip: ${daysToShip}`);
});

// shipment.late — per-seller late delivery tracking (C2/S14)
bus.on('shipment.late', (payload) => {
    const { sellerId, daysLate, carrier } = payload;
    if (!sellerId) return;
    console.log(`[ANALYTICS] Late delivery — seller: ${sellerId}, daysLate: ${daysLate}, carrier: ${carrier || 'N/A'}`);
});

// message.seller_response — seller response time rolling average per seller (C9 / S25)
// Data is already captured via trackedEvents above. This dedicated listener
// logs for visibility and can be extended to compute aggregates on demand.
bus.on('message.seller_response', (payload) => {
    const { sellerId, responseTimeMs, contextType } = payload;
    if (sellerId && responseTimeMs !== undefined) {
        const minutes = Math.round(responseTimeMs / 60000);
        console.log(`[ANALYTICS] Seller ${sellerId} responded in ${minutes}m (context: ${contextType || 'general'})`);
    }
});

// ── Routes ───────────────────────────────────────────────────────────────────

// Summary dashboard — scoped to seller or all if admin
app.get('/dashboard', async (req, res) => {
    try {
        const storeId = req.user?.storeId;
        const isAdmin = req.user?.role === 'admin';

        const orderMetrics = isAdmin
            ? await Metric.find({ event: 'order.placed' })
            : await Metric.find({ event: 'order.placed', 'data.items.sellerId': storeId });

        const totalOrders = orderMetrics.length;
        res.json({ totalOrders });
    } catch (err) { errorResponse(res, 500, err.message); }
});

// Revenue by seller (admin sees all, seller sees own)
app.get('/revenue', async (req, res) => {
    try {
        const storeId = req.user?.storeId;
        const isAdmin = req.user?.role === 'admin';

        const metrics = await Metric.find({ event: 'order.placed' });
        const revenueMap = {};

        metrics.forEach(m => {
            const items = m.data?.items || [];
            items.forEach(item => {
                const sid = item.sellerId?.toString();
                if (!sid) return;
                if (!isAdmin && sid !== storeId?.toString()) return;
                revenueMap[sid] = (revenueMap[sid] || 0) + (item.price * item.qty);
            });
        });

        const result = Object.entries(revenueMap).map(([sellerId, revenueCents]) => ({
            sellerId,
            revenueCents,
            revenueFormatted: `$${(revenueCents / 100).toFixed(2)}`
        }));
        res.json(result);
    } catch (err) { errorResponse(res, 500, err.message); }
});

// Order volume over time (daily buckets)
app.get('/orders', async (req, res) => {
    try {
        const storeId = req.user?.storeId;
        const isAdmin = req.user?.role === 'admin';

        const pipeline = [
            { $match: { event: 'order.placed' } },
            {
                $group: {
                    _id: {
                        year:  { $year: '$timestamp' },
                        month: { $month: '$timestamp' },
                        day:   { $dayOfMonth: '$timestamp' }
                    },
                    count: { $sum: 1 }
                }
            },
            { $sort: { '_id.year': 1, '_id.month': 1, '_id.day': 1 } }
        ];

        const volume = await Metric.aggregate(pipeline);
        res.json(volume);
    } catch (err) { errorResponse(res, 500, err.message); }
});

// Top products by order count
app.get('/top-products', async (req, res) => {
    try {
        const storeId = req.user?.storeId;
        const isAdmin = req.user?.role === 'admin';

        const metrics = await Metric.find({ event: 'order.placed' });
        const countMap = {};

        metrics.forEach(m => {
            const items = m.data?.items || [];
            items.forEach(item => {
                const sid = item.sellerId?.toString();
                if (!isAdmin && sid !== storeId?.toString()) return;
                const pid = item.productId?.toString();
                if (!pid) return;
                if (!countMap[pid]) countMap[pid] = { productId: pid, title: item.title, count: 0, revenueCents: 0 };
                countMap[pid].count++;
                countMap[pid].revenueCents += item.price * item.qty;
            });
        });

        const sorted = Object.values(countMap)
            .sort((a, b) => b.count - a.count)
            .slice(0, 10);
        res.json(sorted);
    } catch (err) { errorResponse(res, 500, err.message); }
});

// ── Smart Catalog: Conversion Funnel Analysis ────────────────────────────────
app.get('/conversion-health/:productId', async (req, res) => {
    try {
        const productId = req.params.productId;
        const storeId = req.user?.storeId;
        const isAdmin = req.user?.role === 'admin';

        const events = await Metric.find({
            'data.productId': productId,
            event: { $in: ['cart.item_added', 'cart.item_removed', 'order.placed'] }
        });

        const funnel = {};
        let authCheckFailed = false;

        events.forEach(e => {
            // Event owner check for non-admins
            // Only strictly applies if event payload carries sellerId
            if (!isAdmin && e.data.sellerId && e.data.sellerId.toString() !== storeId?.toString()) {
                authCheckFailed = true;
            }
            
            // Assume the item was seen at ‘unknown’ price if missing
            const p = e.data.priceAtAdd || e.data.price || 'unknown';
            if (!funnel[p]) funnel[p] = { pricePoint: p, adds: 0, removes: 0, orders: 0 };
            
            if (e.event === 'cart.item_added') funnel[p].adds += (e.data.qty || 1);
            if (e.event === 'cart.item_removed') funnel[p].removes += (e.data.qty || 1);
            if (e.event === 'order.placed') funnel[p].orders += (e.data.qty || 1);
        });

        if (authCheckFailed) return errorResponse(res, 403, 'Access denied for this product');

        const result = Object.values(funnel).map(f => {
            f.dropRate = f.adds > 0 ? parseFloat((f.removes / f.adds).toFixed(2)) : 0;
            return f;
        });

        res.json(result);
    } catch (err) { errorResponse(res, 500, err.message); }
});

// Revenue trend — daily buckets for last N days, seller-scoped
app.get('/revenue-trend', async (req, res) => {
    try {
        const storeId = req.user?.storeId;
        const isAdmin = req.user?.role === 'admin';
        const days    = Math.min(parseInt(req.query.days) || 30, 90);
        const since   = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

        const metrics = await Metric.find({ event: 'order.placed', timestamp: { $gte: since } });
        const buckets = {}; // date string → { date, orders, revenueCents }

        metrics.forEach(m => {
            const items = m.data?.items || [];
            let hasSellerItem = false;
            let dayCents = 0;

            items.forEach(i => {
                const sid = i.sellerId?.toString();
                if (!isAdmin && sid !== storeId?.toString()) return;
                hasSellerItem = true;
                dayCents += (i.price || 0) * (i.qty || 1);
            });

            if (!hasSellerItem) return;
            const d = new Date(m.timestamp);
            const key = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
            if (!buckets[key]) buckets[key] = { date: key, orders: 0, revenueCents: 0 };
            buckets[key].orders++;
            buckets[key].revenueCents += dayCents;
        });

        // Fill missing days with zeros for a clean chart
        const result = [];
        for (let i = days - 1; i >= 0; i--) {
            const d   = new Date(Date.now() - i * 24 * 60 * 60 * 1000);
            const key = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
            result.push(buckets[key] || { date: key, orders: 0, revenueCents: 0 });
        }
        res.json(result);
    } catch (err) { errorResponse(res, 500, err.message); }
});

// Engagement trend — daily buckets for cart adds for last N days, seller-scoped
app.get('/engagement-trend', async (req, res) => {
    try {
        const storeId = req.user?.storeId;
        const isAdmin = req.user?.role === 'admin';
        const days    = Math.min(parseInt(req.query.days) || 30, 90);
        const since   = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

        const metrics = await Metric.find({ event: 'cart.item_added', timestamp: { $gte: since } });
        const buckets = {}; // date string → { date, cartAdds }

        metrics.forEach(m => {
            const sid = m.data?.sellerId?.toString();
            if (!isAdmin && sid !== storeId?.toString()) return;

            const d = new Date(m.timestamp);
            const key = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
            if (!buckets[key]) buckets[key] = { date: key, cartAdds: 0 };
            buckets[key].cartAdds += (m.data?.qty || 1);
        });

        const result = [];
        for (let i = days - 1; i >= 0; i--) {
            const d   = new Date(Date.now() - i * 24 * 60 * 60 * 1000);
            const key = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
            result.push(buckets[key] || { date: key, cartAdds: 0 });
        }
        res.json(result);
    } catch (err) { errorResponse(res, 500, err.message); }
});

// Store Health Metrics
app.get('/store-health', async (req, res) => {
    try {
        const storeId = req.user?.storeId;
        const isAdmin = req.user?.role === 'admin';
        const since   = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

        const [orderMetrics, cartMetrics, missedMetrics] = await Promise.all([
            Metric.find({ event: 'order.placed', timestamp: { $gte: since } }),
            !isAdmin ? Metric.find({ event: 'cart.item_added', timestamp: { $gte: since }, 'data.sellerId': storeId }) : Metric.find({ event: 'cart.item_added', timestamp: { $gte: since } }),
            !isAdmin ? Metric.find({ event: 'inventory.purchase_blocked', timestamp: { $gte: since }, 'data.sellerId': storeId }) : Metric.find({ event: 'inventory.purchase_blocked', timestamp: { $gte: since } })
        ]);

        let orders30d = 0;
        orderMetrics.forEach(m => {
            const items = m.data?.items || [];
            items.forEach(i => {
                if (!isAdmin && i.sellerId?.toString() !== storeId?.toString()) return;
                orders30d++;
            });
        });

        let cartAdds30d = 0;
        cartMetrics.forEach(m => {
            cartAdds30d += (m.data?.qty || 1);
        });

        const totalAttempts = cartAdds30d + orders30d;
        let conversionRate = 0;
        if (totalAttempts > 0) {
            conversionRate = Math.min(orders30d / totalAttempts, 1);
        }

        // A.11 — Fetch seller reputation + catalog metrics for 5-component store score
        let sellerAvgRating = 0;
        let replyRate       = 0;
        let avgQuality      = 0;  // avg qualityScore across seller's active products (0–100)
        let topVelocity     = 0;  // highest velocityScore product, normalised 0–1

        if (storeId) {
            // Seller reputation from seller-service
            try {
                const sRes = await fetch(`http://localhost:5005/${storeId}`);
                if (sRes.ok) {
                    const s = await sRes.json();
                    sellerAvgRating = s.sellerAvgRating || 0;
                    replyRate       = s.replyRate       || 0;
                }
            } catch {}

            // Quality and velocity from catalog-service smartMetrics
            try {
                const cRes = await fetch(`http://localhost:5002/by-seller/${storeId}`);
                if (cRes.ok) {
                    const products = await cRes.json();
                    if (Array.isArray(products) && products.length > 0) {
                        const qualities  = products.map(p => p.smartMetrics?.qualityScore  || 0);
                        const velocities = products.map(p => p.smartMetrics?.velocityScore || 0);
                        avgQuality  = qualities.reduce((s, v) => s + v, 0) / qualities.length;
                        // Normalise: velocityScore has no defined ceiling — use 100 as a reasonable cap
                        topVelocity = Math.min(Math.max(...velocities) / 100, 1);
                    }
                }
            } catch {}
        }

        // Five-component store score (weights sum to 1.0):
        //   avgQuality  (0–100 → 0–1) × 0.15
        //   topVelocity (0–1)         × 0.25
        //   conversionRate (0–1)      × 0.25
        //   sellerAvgRating/5 (0–1)   × 0.25
        //   replyRate (0–1)           × 0.10
        const storeScore = Math.min(100, Math.round((
            (avgQuality / 100)      * 0.15 +
            topVelocity             * 0.25 +
            conversionRate          * 0.25 +
            (sellerAvgRating / 5)   * 0.25 +
            replyRate               * 0.10
        ) * 100));  // weighted sum is 0–1; multiply by 100 then round to get 0–100 integer

        res.json({
            cartAdds30d,
            orders30d,
            conversionRate,
            missedSalesCount: missedMetrics.length,
            sellerAvgRating,
            replyRate,
            storeScore
        });
    } catch (err) { errorResponse(res, 500, err.message); }
});

// Missed sales — inventory.purchase_blocked events for this seller
app.get('/missed-sales', async (req, res) => {
    try {
        const storeId = req.user?.storeId;
        const isAdmin = req.user?.role === 'admin';

        const query = { event: 'inventory.purchase_blocked' };
        if (!isAdmin && storeId) query['data.sellerId'] = storeId;

        const events = await Metric.find(query).sort({ timestamp: -1 }).limit(50);
        res.json(events.map(e => ({
            timestamp:   e.timestamp,
            productId:   e.data.productId,
            title:       e.data.title,
            qtyWanted:   e.data.qtyWanted,
            available:   e.data.available,
            buyerId:     e.data.buyerId,
            revenueLost: (e.data.qtyWanted || 1) * (e.data.price || 0)
        })));
    } catch (err) { errorResponse(res, 500, err.message); }
});

// Store pulse — quick aggregate for seller dashboard header cards
app.get('/store-pulse', async (req, res) => {
    try {
        const storeId = req.user?.storeId;
        const isAdmin = req.user?.role === 'admin';
        const since30 = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

        const [orderMetrics, missedMetrics, stockLowMetrics] = await Promise.all([
            Metric.find({ event: 'order.placed', timestamp: { $gte: since30 } }),
            Metric.find({ event: 'inventory.purchase_blocked', ...(isAdmin ? {} : { 'data.sellerId': storeId }) }),
            Metric.find({ event: 'inventory.stock_low',        ...(isAdmin ? {} : { 'data.sellerId': storeId }) })
        ]);

        let ordersThisMonth = 0, revenueThisMonth = 0;
        orderMetrics.forEach(m => {
            const items = m.data?.items || [];
            items.forEach(i => {
                const sid = i.sellerId?.toString();
                if (!isAdmin && sid !== storeId?.toString()) return;
                ordersThisMonth++;
                revenueThisMonth += (i.price || 0) * (i.qty || 1);
            });
        });

        res.json({
            ordersThisMonth,
            revenueThisMonth,
            missedSalesCount:    missedMetrics.length,
            lowStockAlertCount:  stockLowMetrics.length
        });
    } catch (err) { errorResponse(res, 500, err.message); }
});

// A.10 — Review summary: seller's review stats (proxied from review-service)
app.get('/review-summary', async (req, res) => {
    try {
        const storeId = req.user?.storeId;
        const isAdmin = req.user?.role === 'admin';
        if (!storeId && !isAdmin) return errorResponse(res, 400, 'Seller context required');

        const endpoint = storeId
            ? `http://localhost:5008/seller/${storeId}/stats`
            : `http://localhost:5008/seller/all/stats`;

        const rRes = await fetch(endpoint);
        if (!rRes.ok) return res.json({ avgRating: 0, totalCount: 0, replyRate: 0, fiveStarPct: 0, oneStarPct: 0 });
        const stats = await rRes.json();
        res.json(stats);
    } catch (err) { errorResponse(res, 500, err.message); }
});

// S27/C-S2 — Seller tier computation: runs daily, evaluates rolling 90-day GMV + avgRating
// Thresholds (configurable via env): TOP_GMV, RISING_GMV, TOP_RATING, RISING_RATING, TOP_ONTIME
const TOP_GMV_THRESHOLD    = parseInt(process.env.TOP_GMV_CENTS    || '500000');  // CA$5000
const RISING_GMV_THRESHOLD = parseInt(process.env.RISING_GMV_CENTS || '100000'); // CA$1000
const TOP_RATING_MIN    = parseFloat(process.env.TOP_RATING_MIN    || '4.5');
const RISING_RATING_MIN = parseFloat(process.env.RISING_RATING_MIN || '4.2');

async function runTierEvaluation() {
    try {
        const since = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000);
        const orderMetrics = await Metric.find({ event: 'order.placed', timestamp: { $gte: since } });

        // Compute 90-day GMV per seller
        const gmvBySeller = {};
        orderMetrics.forEach(m => {
            (m.data?.items || []).forEach(item => {
                const sid = item.sellerId?.toString();
                if (!sid) return;
                gmvBySeller[sid] = (gmvBySeller[sid] || 0) + (item.price * item.qty);
            });
        });

        // Evaluate each seller's tier
        for (const [sellerId, gmv] of Object.entries(gmvBySeller)) {
            let tier = 'standard';
            try {
                const controller = new AbortController();
                setTimeout(() => controller.abort(), 2500);
                const r = await fetch(`http://localhost:5005/by-seller/${sellerId}`, { signal: controller.signal });
                const store = r.ok ? await r.json() : null;
                const avgRating = store?.sellerAvgRating || 0;

                if (gmv >= TOP_GMV_THRESHOLD && avgRating >= TOP_RATING_MIN) {
                    tier = 'top';
                } else if (gmv >= RISING_GMV_THRESHOLD || avgRating >= RISING_RATING_MIN) {
                    tier = 'rising';
                }
            } catch { /* fail open — seller unreachable, keep standard */ }

            bus.emit('seller.tier_updated', { sellerId, tier, gmv90d: gmv });
            console.log(`[ANALYTICS] seller.tier_updated: ${sellerId} → ${tier} (90d GMV: ${gmv})`);
        }
    } catch (err) { console.error('[ANALYTICS] tier evaluation error:', err.message); }
}

// Run once on startup (catches sellers on day 1), then every 24h
runTierEvaluation();
setInterval(runTierEvaluation, 24 * 60 * 60 * 1000);

// ── Admin platform endpoints ──────────────────────────────────────────────────

// GET /admin/platform-pulse — real-time platform snapshot
app.get('/admin/platform-pulse', async (req, res) => {
    try {
        const today = new Date(); today.setHours(0, 0, 0, 0);
        const [ordersToday, ordersWeek, ordersMonth, totalOrders] = await Promise.all([
            Metric.countDocuments({ event: 'order.placed', timestamp: { $gte: today } }),
            Metric.countDocuments({ event: 'order.placed', timestamp: { $gte: new Date(Date.now() - 7 * 24 * 3600 * 1000) } }),
            Metric.countDocuments({ event: 'order.placed', timestamp: { $gte: new Date(Date.now() - 30 * 24 * 3600 * 1000) } }),
            Metric.countDocuments({ event: 'order.placed' })
        ]);

        const todayMetrics = await Metric.find({ event: 'order.placed', timestamp: { $gte: today } });
        let gmvToday = 0;
        todayMetrics.forEach(m => (m.data?.items || []).forEach(i => { gmvToday += (i.price || 0) * (i.qty || 1); }));

        const reviewsPending = await Metric.countDocuments({ event: 'review.submitted', timestamp: { $gte: new Date(Date.now() - 30 * 24 * 3600 * 1000) } });

        res.json({
            ordersToday, ordersWeek, ordersMonth, totalOrders,
            gmvToday, gmvTodayFormatted: `$${(gmvToday / 100).toFixed(2)}`,
            reviewsPending,
            generatedAt: new Date()
        });
    } catch (err) { errorResponse(res, 500, err.message); }
});

// GET /admin/anomalies — simple anomaly detection
app.get('/admin/anomalies', async (req, res) => {
    try {
        const hour = new Date(Date.now() - 3600 * 1000);
        const day  = new Date(Date.now() - 86400 * 1000);

        const [ordersHour, ordersDay, refundsHour, refundsDay] = await Promise.all([
            Metric.countDocuments({ event: 'order.placed', timestamp: { $gte: hour } }),
            Metric.countDocuments({ event: 'order.placed', timestamp: { $gte: day } }),
            Metric.countDocuments({ event: 'payment.refunded', timestamp: { $gte: hour } }),
            Metric.countDocuments({ event: 'payment.refunded', timestamp: { $gte: day } })
        ]);

        const anomalies = [];
        const avgOrdersPerHour = ordersDay / 24;
        if (avgOrdersPerHour > 0 && ordersHour > avgOrdersPerHour * 3) {
            anomalies.push({ type: 'ORDER_SPIKE', severity: 'medium', detail: `${ordersHour} orders in last hour vs avg ${avgOrdersPerHour.toFixed(1)}/hr` });
        }
        if (avgOrdersPerHour > 0 && ordersHour < avgOrdersPerHour * 0.1) {
            anomalies.push({ type: 'ORDER_DROP', severity: 'high', detail: `Only ${ordersHour} orders in last hour vs avg ${avgOrdersPerHour.toFixed(1)}/hr` });
        }
        const avgRefundsPerHour = refundsDay / 24;
        if (avgRefundsPerHour > 0 && refundsHour > avgRefundsPerHour * 5) {
            anomalies.push({ type: 'REFUND_SPIKE', severity: 'high', detail: `${refundsHour} refunds in last hour vs avg ${avgRefundsPerHour.toFixed(1)}/hr` });
        }

        res.json({ anomalies, generatedAt: new Date() });
    } catch (err) { errorResponse(res, 500, err.message); }
});

app.get('/health', (req, res) => {
    res.json({ service: 'analytics-service', status: 'ok', dbState: db.readyState === 1 ? 'connected' : 'disconnected' });
});

app.listen(process.env.PORT || 5011, () => console.log(`Analytics Service on port ${process.env.PORT || 5011}`));
