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
db.on('connected', () => console.log('Review DB Connected'));
db.on('error', (err) => console.error('[REVIEW] DB error:', err.message));

// ── Schemas ──────────────────────────────────────────────────────────────────

const ReviewSchema = new mongoose.Schema({
    // Core (existing)
    productId: { type: mongoose.Schema.Types.ObjectId, required: true },
    sellerId:  { type: mongoose.Schema.Types.ObjectId, required: true }, // NEW — required for seller notif & reply auth
    buyerId:   { type: mongoose.Schema.Types.ObjectId, required: true },
    orderId:   { type: mongoose.Schema.Types.ObjectId, required: true },
    rating:    { type: Number, min: 1, max: 5, required: true },
    body:      String,
    status:    { type: String, enum: ['pending', 'approved', 'flagged'], default: 'approved' }, // CHANGED: default→approved
    createdAt: { type: Date, default: Date.now, index: true },

    // Media & quality
    imageUrl:     String,
    qualityScore: { type: Number, default: 0 },

    // Helpful voting
    helpfulCount:  { type: Number, default: 0 },
    helpfulVoters: [{ type: mongoose.Schema.Types.ObjectId }],

    // Flagging
    flagCount:  { type: Number, default: 0 },
    flagVoters: [{ type: mongoose.Schema.Types.ObjectId }],

    // Seller reply
    sellerReply: {
        body:      String,
        repliedAt: Date,
        addressed: { type: Boolean, default: false }
    },

    // Audit trail
    statusHistory: [{
        status:    String,
        changedAt: { type: Date, default: Date.now },
        reason:    String  // 'auto_approved', 'admin_flagged', 'crowd_flagged', 'admin_approved'
    }]
});
ReviewSchema.index({ productId: 1, status: 1 });
ReviewSchema.index({ buyerId: 1 });
ReviewSchema.index({ sellerId: 1, status: 1 });
ReviewSchema.index({ helpfulCount: -1 });
const Review = db.model('Review', ReviewSchema);

// Seller-level reviews (buyer reviews the seller, not a product)
const SellerReviewSchema = new mongoose.Schema({
    sellerId:  { type: mongoose.Schema.Types.ObjectId, required: true },
    buyerId:   { type: mongoose.Schema.Types.ObjectId, required: true },
    orderId:   { type: mongoose.Schema.Types.ObjectId, required: true },
    rating:    { type: Number, min: 1, max: 5, required: true },
    body:      String,
    tags:      [{ type: String }],  // e.g. ['fast_shipping', 'good_communication', 'as_described']
    status:    { type: String, enum: ['pending', 'approved', 'flagged'], default: 'approved' },
    createdAt: { type: Date, default: Date.now, index: true }
});
SellerReviewSchema.index({ sellerId: 1, status: 1 });
SellerReviewSchema.index({ buyerId: 1 });
const SellerReview = db.model('SellerReview', SellerReviewSchema);

// 48h review nudge tracking
const NudgeSchema = new mongoose.Schema({
    orderId:     { type: mongoose.Schema.Types.ObjectId, required: true, unique: true },
    buyerId:     { type: mongoose.Schema.Types.ObjectId, required: true },
    items:       [{ productId: mongoose.Schema.Types.ObjectId, title: String }],
    deliveredAt: { type: Date, required: true },
    nudgeSent:   { type: Boolean, default: false }
});
const Nudge = db.model('Nudge', NudgeSchema);

// Persists delivered orderIds so unlock set survives restarts
const DeliveredOrderSchema = new mongoose.Schema({
    orderId: { type: mongoose.Schema.Types.ObjectId, required: true, unique: true },
    at:      { type: Date, default: Date.now }
});
const DeliveredOrder = db.model('DeliveredOrder', DeliveredOrderSchema);

// ── Local delivery unlock tracking ──────────────────────────────────────────
const deliveredSet = new Set();

db.on('connected', async () => {
    try {
        const records = await DeliveredOrder.find({}, 'orderId');
        records.forEach(r => deliveredSet.add(r.orderId.toString()));
        console.log(`[REVIEW] Seeded deliveredSet with ${deliveredSet.size} entries`);
    } catch (err) { console.error('[REVIEW] deliveredSet seed error:', err.message); }
});

// ── Helpers ──────────────────────────────────────────────────────────────────

function computeQualityScore(body, imageUrl, rating) {
    let score = 20; // base for verified purchase
    if (body) {
        if (body.length >= 50) score += 40;
        else if (body.length >= 10) score += 20;
    }
    if (imageUrl) score += 30;
    if (rating === 1 || rating === 5) score += 10;
    return Math.min(score, 100);
}

async function getProductAvgAndCount(productId) {
    const approved = await Review.find({ productId, status: 'approved' });
    const count = approved.length;
    const avg = count ? approved.reduce((s, r) => s + r.rating, 0) / count : 0;
    return { avgRating: Math.round(avg * 10) / 10, reviewCount: count };
}

async function computeBreakdown(productId) {
    const dist = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
    const all = await Review.find({ productId, status: 'approved' }, 'rating');
    all.forEach(r => { if (dist[r.rating] !== undefined) dist[r.rating]++; });
    return dist;
}

// ── Event listeners ──────────────────────────────────────────────────────────

bus.on('shipment.delivered', async (payload) => {
    try {
        const oid = payload.orderId?.toString();
        if (!oid) return;
        deliveredSet.add(oid);
        await DeliveredOrder.updateOne({ orderId: payload.orderId }, { orderId: payload.orderId }, { upsert: true });

        // Upsert nudge record for 48h follow-up
        if (payload.buyerId) {
            await Nudge.updateOne(
                { orderId: payload.orderId },
                {
                    orderId:     payload.orderId,
                    buyerId:     payload.buyerId,
                    items:       payload.items || [],
                    deliveredAt: new Date()
                },
                { upsert: true }
            );
        }
        console.log(`[REVIEW] Delivery unlocked for order ${oid}`);
    } catch (err) { console.error('[REVIEW] shipment.delivered error:', err.message); }
});

// Shared delivery unlock helper — same logic as shipment.delivered (R13, R14, C7)
async function unlockDelivery(payload, trigger) {
    try {
        const oid = payload.orderId?.toString();
        if (!oid) return;
        deliveredSet.add(oid);
        await DeliveredOrder.updateOne({ orderId: payload.orderId }, { orderId: payload.orderId }, { upsert: true });
        if (payload.buyerId) {
            await Nudge.updateOne(
                { orderId: payload.orderId },
                { orderId: payload.orderId, buyerId: payload.buyerId, items: payload.items || [], deliveredAt: new Date() },
                { upsert: true }
            );
        }
        console.log(`[REVIEW] Delivery unlocked via ${trigger} for order ${oid}`);
    } catch (err) { console.error(`[REVIEW] ${trigger} unlock error:`, err.message); }
}

bus.on('order.picked_up',          payload => unlockDelivery(payload, 'order.picked_up'));
bus.on('order.self_fulfilled',     payload => unlockDelivery(payload, 'order.self_fulfilled'));
bus.on('shipment.buyer_confirmed', payload => unlockDelivery(payload, 'shipment.buyer_confirmed'));
// S5 — COD collection is a delivery event — unlock reviews for COD orders
bus.on('payment.collected',        payload => unlockDelivery(payload, 'payment.collected'));

bus.on('user.deleted', async (payload) => {
    try {
        const uid = payload.userId;
        // Product reviews left by the buyer
        const r1 = await Review.deleteMany({ buyerId: uid });
        // Seller reviews (buyer-as-reviewer and any where this user was the seller)
        const r2 = await SellerReview.deleteMany({ $or: [{ buyerId: uid }, { sellerId: uid }] });
        // Review nudge records for this buyer
        const r3 = await Nudge.deleteMany({ buyerId: uid });
        console.log(`[REVIEW] user.deleted cleanup: ${r1.deletedCount} reviews, ${r2.deletedCount} seller-reviews, ${r3.deletedCount} nudges for user ${uid}`);
    } catch (err) { console.error('[REVIEW] user.deleted cleanup error:', err.message); }
});

// ── Hourly nudge processor ───────────────────────────────────────────────────
setInterval(async () => {
    try {
        const cutoff = new Date(Date.now() - 48 * 60 * 60 * 1000);
        const nudges = await Nudge.find({ deliveredAt: { $lt: cutoff }, nudgeSent: false }).limit(100);
        for (const n of nudges) {
            // Mark sent BEFORE emitting — if process crashes after emit but before DB write,
            // the nudge would re-fire on restart (double nudge). DB write first prevents that.
            await Nudge.updateOne({ _id: n._id }, { nudgeSent: true });
            bus.emit('review.nudge', { buyerId: n.buyerId, orderId: n.orderId, items: n.items });
        }
        if (nudges.length) console.log(`[REVIEW] Sent ${nudges.length} nudges`);
    } catch (err) { console.error('[REVIEW] nudge interval error:', err.message); }
}, 60 * 60 * 1000);

// ── Routes ───────────────────────────────────────────────────────────────────

// POST / — submit a product review
app.post('/', async (req, res) => {
    if (!req.user?.sub) return errorResponse(res, 401, 'Unauthorized');
    try {
        let { productId, sellerId, orderId, rating, body, imageUrl } = req.body;
        if (!productId || !orderId || !rating) return errorResponse(res, 400, 'Missing required fields');

        // Purchase verification
        if (!deliveredSet.has(orderId?.toString())) {
            return errorResponse(res, 403, 'Cannot review — order has not been delivered yet');
        }

        // Duplicate guard
        const existing = await Review.findOne({ productId, buyerId: req.user.sub, orderId });
        if (existing) return errorResponse(res, 409, 'You have already reviewed this product for this order');

        // Resolve sellerId from catalog if missing
        if (!sellerId) {
            try {
                const pRes = await fetch(`http://localhost:5002/products/${productId}`);
                if (pRes.ok) {
                    const p = await pRes.json();
                    sellerId = p.sellerId;
                }
            } catch {}
        }

        const qualityScore = computeQualityScore(body, imageUrl, rating);

        const rev = await Review.create({
            productId, orderId, rating, body, imageUrl, qualityScore,
            sellerId: sellerId || null,
            buyerId:  req.user.sub,
            status:   'approved',
            statusHistory: [{ status: 'approved', reason: 'auto_approved' }]
        });

        // Compute updated avg for downstream events
        const { avgRating, reviewCount } = await getProductAvgAndCount(productId);

        bus.emit('review.submitted', {
            reviewId: rev._id, productId, sellerId, buyerId: req.user.sub,
            rating, avgRating, reviewCount, qualityScore
        });
        bus.emit('review.approved', { productId, rating, avgRating, reviewCount });

        res.status(201).json(rev);
    } catch (err) { errorResponse(res, 500, err.message); }
});

// GET /check/:productId — fast eligibility check (no full order list needed)
app.get('/check/:productId', async (req, res) => {
    if (!req.user?.sub) return errorResponse(res, 401, 'Unauthorized');
    try {
        // Find any delivered order containing this product for this buyer
        // We do this via DeliveredOrder set — cross reference with a catalog lookup
        // Simpler approach: check if buyer already reviewed + any deliveredSet entry matches an order they placed
        const alreadyReviewed = !!(await Review.findOne({ productId: req.params.productId, buyerId: req.user.sub }));

        // Check delivered orders that contain this product via order-service internal call
        let canReview = false;
        let eligibleOrderId = null;
        try {
            const oRes = await fetch(`http://localhost:5003/my-orders`, {
                headers: { 'x-user': JSON.stringify(req.user) }
            });
            if (oRes.ok) {
                const orders = await oRes.json();
                for (const o of orders) {
                    if (o.status === 'delivered' && deliveredSet.has(o._id?.toString())) {
                        const hasItem = (o.items || []).some(i => i.productId?.toString() === req.params.productId);
                        if (hasItem) { canReview = true; eligibleOrderId = o._id; break; }
                    }
                }
            }
        } catch {}

        res.json({ canReview, alreadyReviewed, orderId: eligibleOrderId });
    } catch (err) { errorResponse(res, 500, err.message); }
});

// GET /product/:productId — public approved reviews with breakdown + sorting
app.get('/product/:productId', async (req, res) => {
    try {
        const { sort, stars } = req.query;
        const filter = { productId: req.params.productId, status: 'approved' };
        if (stars) filter.rating = parseInt(stars);

        let sortObj = { helpfulCount: -1, createdAt: -1 };
        if (sort === 'recent')      sortObj = { createdAt: -1 };
        if (sort === 'helpful')     sortObj = { helpfulCount: -1, createdAt: -1 };
        if (sort === 'rating_asc')  sortObj = { rating: 1, createdAt: -1 };
        if (sort === 'rating_desc') sortObj = { rating: -1, createdAt: -1 };

        const reviews = await Review.find(filter).sort(sortObj);
        const { avgRating, reviewCount } = await getProductAvgAndCount(req.params.productId);
        const breakdown = await computeBreakdown(req.params.productId);

        res.json({ reviews, avgRating, totalCount: reviewCount, breakdown });
    } catch (err) { errorResponse(res, 500, err.message); }
});

// POST /:id/helpful — vote a review helpful
app.post('/:id/helpful', async (req, res) => {
    if (!req.user?.sub) return errorResponse(res, 401, 'Unauthorized');
    try {
        const userId = new mongoose.Types.ObjectId(req.user.sub);
        const rev = await Review.findById(req.params.id);
        if (!rev) return errorResponse(res, 404, 'Review not found');
        if (rev.status !== 'approved') return errorResponse(res, 400, 'Can only vote on approved reviews');

        const alreadyVoted = rev.helpfulVoters.some(v => v.toString() === req.user.sub);
        if (alreadyVoted) return res.json({ helpfulCount: rev.helpfulCount, alreadyVoted: true });

        const updated = await Review.findByIdAndUpdate(
            req.params.id,
            { $addToSet: { helpfulVoters: userId }, $inc: { helpfulCount: 1 } },
            { new: true }
        );
        res.json({ helpfulCount: updated.helpfulCount, alreadyVoted: false });
    } catch (err) { errorResponse(res, 500, err.message); }
});

// POST /:id/flag — flag a review
app.post('/:id/flag', async (req, res) => {
    if (!req.user?.sub) return errorResponse(res, 401, 'Unauthorized');
    try {
        const userId = new mongoose.Types.ObjectId(req.user.sub);
        const rev = await Review.findById(req.params.id);
        if (!rev) return errorResponse(res, 404, 'Review not found');

        const alreadyFlagged = rev.flagVoters.some(v => v.toString() === req.user.sub);
        if (alreadyFlagged) return res.json({ flagCount: rev.flagCount, alreadyFlagged: true });

        const newFlagCount = rev.flagCount + 1;
        const update = {
            $addToSet: { flagVoters: userId },
            $inc: { flagCount: 1 }
        };

        // Threshold: 3 flags returns to pending for moderation
        if (newFlagCount >= 3) {
            update.$set = { status: 'pending' };
            update.$push = { statusHistory: { status: 'pending', reason: 'crowd_flagged' } };
        }

        const updated = await Review.findByIdAndUpdate(req.params.id, update, { new: true });

        if (newFlagCount >= 3) {
            bus.emit('review.flagged', { reviewId: rev._id, productId: rev.productId, flagCount: newFlagCount });
        }

        res.json({ flagCount: updated.flagCount });
    } catch (err) { errorResponse(res, 500, err.message); }
});

// PATCH /:id/reply — seller replies to a review
app.patch('/:id/reply', async (req, res) => {
    if (!req.user?.sub) return errorResponse(res, 401, 'Unauthorized');
    try {
        const { body } = req.body;
        if (!body) return errorResponse(res, 400, 'Reply body is required');

        const rev = await Review.findById(req.params.id);
        if (!rev) return errorResponse(res, 404, 'Review not found');

        // Ownership check: req.user.storeId must match review's sellerId
        const storeId = req.user.storeId?.toString();
        if (!storeId || storeId !== rev.sellerId?.toString()) {
            return errorResponse(res, 403, 'Only the product seller can reply to this review');
        }

        // One reply per review
        if (rev.sellerReply?.body) return errorResponse(res, 409, 'You have already replied to this review');

        const updated = await Review.findByIdAndUpdate(
            req.params.id,
            { sellerReply: { body, repliedAt: new Date(), addressed: false } },
            { new: true }
        );

        bus.emit('seller.replied', {
            reviewId:  rev._id,
            productId: rev.productId,
            sellerId:  rev.sellerId,
            buyerId:   rev.buyerId
        });

        res.json(updated);
    } catch (err) { errorResponse(res, 500, err.message); }
});

// PATCH /:id/reply/address — seller marks reply as "addressed"
app.patch('/:id/reply/address', async (req, res) => {
    if (!req.user?.sub) return errorResponse(res, 401, 'Unauthorized');
    try {
        const rev = await Review.findById(req.params.id);
        if (!rev) return errorResponse(res, 404, 'Review not found');

        const storeId = req.user.storeId?.toString();
        if (!storeId || storeId !== rev.sellerId?.toString()) {
            return errorResponse(res, 403, 'Only the product seller can update this reply');
        }
        if (!rev.sellerReply?.body) return errorResponse(res, 400, 'No reply exists to mark as addressed');

        const updated = await Review.findByIdAndUpdate(
            req.params.id,
            { 'sellerReply.addressed': !rev.sellerReply.addressed },
            { new: true }
        );
        res.json(updated);
    } catch (err) { errorResponse(res, 500, err.message); }
});

// GET /my-reviews — buyer's own reviews
app.get('/my-reviews', async (req, res) => {
    if (!req.user?.sub) return errorResponse(res, 401, 'Unauthorized');
    try {
        const reviews = await Review.find({ buyerId: req.user.sub }).sort({ createdAt: -1 });
        res.json(reviews);
    } catch (err) { errorResponse(res, 500, err.message); }
});

// GET /seller/:storeId/stats — lightweight stats for storefront sidebar
app.get('/seller/:storeId/stats', async (req, res) => {
    try {
        const storeId = req.params.storeId;
        const reviews = await Review.find({ sellerId: storeId, status: 'approved' });
        const total = reviews.length;
        if (!total) return res.json({ avgRating: 0, totalCount: 0, replyRate: 0, fiveStarPct: 0, oneStarPct: 0 });

        const avg = reviews.reduce((s, r) => s + r.rating, 0) / total;
        const withReply = reviews.filter(r => r.sellerReply?.body).length;
        const fiveStar  = reviews.filter(r => r.rating === 5).length;
        const oneStar   = reviews.filter(r => r.rating === 1).length;

        res.json({
            avgRating:   Math.round(avg * 10) / 10,
            totalCount:  total,
            replyRate:   Math.round((withReply / total) * 100) / 100,
            fiveStarPct: Math.round((fiveStar  / total) * 100),
            oneStarPct:  Math.round((oneStar   / total) * 100)
        });
    } catch (err) { errorResponse(res, 500, err.message); }
});

// GET /seller/:storeId/needing-reply — seller dashboard widget
app.get('/seller/:storeId/needing-reply', async (req, res) => {
    if (!req.user?.sub) return errorResponse(res, 401, 'Unauthorized');
    try {
        const storeId = req.params.storeId;
        if (req.user.storeId?.toString() !== storeId && req.user.role !== 'admin') {
            return errorResponse(res, 403, 'Seller access only');
        }
        const reviews = await Review.find({
            sellerId:            storeId,
            status:              'approved',
            'sellerReply.body':  { $exists: false }
        }).sort({ createdAt: -1 }).limit(20);
        res.json(reviews);
    } catch (err) { errorResponse(res, 500, err.message); }
});

// GET /seller/:storeId — full approved reviews for a store (storefront page)
app.get('/seller/:storeId', async (req, res) => {
    try {
        const storeId = req.params.storeId;
        const { sort, stars } = req.query;
        const filter = { sellerId: storeId, status: 'approved' };
        if (stars) filter.rating = parseInt(stars);

        let sortObj = { helpfulCount: -1, createdAt: -1 };
        if (sort === 'recent') sortObj = { createdAt: -1 };

        const reviews = await Review.find(filter).sort(sortObj).limit(50);
        const total = reviews.length;
        const avg   = total ? reviews.reduce((s, r) => s + r.rating, 0) / total : 0;
        const withReply = reviews.filter(r => r.sellerReply?.body).length;
        const breakdown = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
        reviews.forEach(r => { if (breakdown[r.rating] !== undefined) breakdown[r.rating]++; });

        res.json({
            reviews,
            avgRating:  Math.round(avg * 10) / 10,
            totalCount: total,
            breakdown,
            replyRate:  total ? Math.round((withReply / total) * 100) / 100 : 0
        });
    } catch (err) { errorResponse(res, 500, err.message); }
});

// POST /seller — submit a seller-level review
app.post('/seller', async (req, res) => {
    if (!req.user?.sub) return errorResponse(res, 401, 'Unauthorized');
    try {
        const { sellerId, orderId, rating, body, tags } = req.body;
        if (!sellerId || !orderId || !rating) return errorResponse(res, 400, 'Missing required fields');

        // Purchase verification
        if (!deliveredSet.has(orderId?.toString())) {
            return errorResponse(res, 403, 'Cannot review seller — order has not been delivered yet');
        }

        // One seller review per buyer per order
        const existing = await SellerReview.findOne({ sellerId, buyerId: req.user.sub, orderId });
        if (existing) return errorResponse(res, 409, 'You have already reviewed this seller for this order');

        const rev = await SellerReview.create({
            sellerId, orderId, rating, body, tags: tags || [],
            buyerId: req.user.sub,
            status:  'approved'
        });

        // Compute new seller avg
        const approved = await SellerReview.find({ sellerId, status: 'approved' });
        const count    = approved.length;
        const avg      = count ? approved.reduce((s, r) => s + r.rating, 0) / count : 0;

        bus.emit('seller.reviewed', {
            sellerId, buyerId: req.user.sub, rating,
            avgRating:   Math.round(avg * 10) / 10,
            reviewCount: count
        });

        res.status(201).json(rev);
    } catch (err) { errorResponse(res, 500, err.message); }
});

// GET /seller-reviews/:sellerId — public seller reviews
app.get('/seller-reviews/:sellerId', async (req, res) => {
    try {
        const reviews = await SellerReview.find({ sellerId: req.params.sellerId, status: 'approved' })
            .sort({ createdAt: -1 }).limit(30);
        const total = reviews.length;
        const avg   = total ? reviews.reduce((s, r) => s + r.rating, 0) / total : 0;
        const breakdown = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
        reviews.forEach(r => { if (breakdown[r.rating] !== undefined) breakdown[r.rating]++; });

        res.json({ reviews, avgRating: Math.round(avg * 10) / 10, totalCount: total, breakdown });
    } catch (err) { errorResponse(res, 500, err.message); }
});

// GET /pending — admin moderation queue (pending + flagged)
app.get('/pending', async (req, res) => {
    try {
        const [pending, flagged] = await Promise.all([
            Review.find({ status: 'pending' }).sort({ createdAt: -1 }),
            Review.find({ status: 'flagged' }).sort({ createdAt: -1 })
        ]);
        res.json({ pending, flagged });
    } catch (err) { errorResponse(res, 500, err.message); }
});

// PATCH /:id/moderate — admin approve or flag
app.patch('/:id/moderate', async (req, res) => {
    try {
        const { status, reason } = req.body;
        if (!['approved', 'flagged'].includes(status)) {
            return errorResponse(res, 400, 'Status must be approved or flagged');
        }

        const rev = await Review.findByIdAndUpdate(
            req.params.id,
            {
                status,
                $push: { statusHistory: { status, reason: reason || 'admin_moderated' } }
            },
            { new: true }
        );
        if (!rev) return errorResponse(res, 404, 'Review not found');

        if (status === 'approved') {
            const { avgRating, reviewCount } = await getProductAvgAndCount(rev.productId);
            bus.emit('review.approved', { productId: rev.productId, rating: rev.rating, avgRating, reviewCount });
        }
        res.json(rev);
    } catch (err) { errorResponse(res, 500, err.message); }
});

// DELETE /admin/:id — hard delete a review (admin only)
app.delete('/admin/:id', async (req, res) => {
    try {
        const { reason } = req.body || {};
        const rev = await Review.findByIdAndDelete(req.params.id);
        if (!rev) return errorResponse(res, 404, 'Review not found');

        // Recalculate product rating after deletion
        const { avgRating, reviewCount } = await getProductAvgAndCount(rev.productId);
        bus.emit('review.deleted', {
            reviewId: rev._id,
            productId: rev.productId,
            avgRating,
            reviewCount,
            reason: reason || 'admin_removed'
        });

        res.json({ success: true, deleted: rev._id });
    } catch (err) { errorResponse(res, 500, err.message); }
});

app.get('/health', (req, res) => {
    res.json({ service: 'review-service', status: 'ok', dbState: db.readyState === 1 ? 'connected' : 'disconnected' });
});

app.listen(process.env.PORT || 5008, () => console.log(`Review Service on port ${process.env.PORT || 5008}`));
