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
db.on('connected', () => console.log('Seller DB Connected'));
db.on('error', (err) => console.error('[SELLER] DB error:', err.message));

app.get('/health', (req, res) => {
    res.json({ service: 'seller-service', status: 'ok', dbState: db.readyState === 1 ? 'connected' : 'disconnected' });
});

// ── Schema ───────────────────────────────────────────────────────────────────

const StoreSchema = new mongoose.Schema({
    name:        { type: String, required: true },
    description: { type: String, default: '' },
    phone:       { type: String, default: '' },
    sellerId:    { type: mongoose.Schema.Types.ObjectId, required: true, unique: true },

    isOpen: { type: Boolean, default: true },

    businessHours: {
        openTime:  { type: String, default: '09:00' },
        closeTime: { type: String, default: '18:00' },
        days:      { type: [String], default: ['Mon','Tue','Wed','Thu','Fri'] }
    },

    schedule: {
        mon: { open: { type: Boolean, default: true  }, openTime: { type: String, default: '09:00' }, closeTime: { type: String, default: '18:00' } },
        tue: { open: { type: Boolean, default: true  }, openTime: { type: String, default: '09:00' }, closeTime: { type: String, default: '18:00' } },
        wed: { open: { type: Boolean, default: true  }, openTime: { type: String, default: '09:00' }, closeTime: { type: String, default: '18:00' } },
        thu: { open: { type: Boolean, default: true  }, openTime: { type: String, default: '09:00' }, closeTime: { type: String, default: '18:00' } },
        fri: { open: { type: Boolean, default: true  }, openTime: { type: String, default: '09:00' }, closeTime: { type: String, default: '17:00' } },
        sat: { open: { type: Boolean, default: false }, openTime: { type: String, default: '10:00' }, closeTime: { type: String, default: '15:00' } },
        sun: { open: { type: Boolean, default: false }, openTime: { type: String, default: '10:00' }, closeTime: { type: String, default: '15:00' } },
    },

    discount: {
        storeWide: {
            enabled: { type: Boolean, default: false },
            percent: { type: Number, default: 0, min: 0, max: 100 },
            endsAt:  { type: Date }
        },
        byCategory: [{
            category: String,
            percent:  { type: Number, min: 0, max: 100 },
            endsAt:   { type: Date }
        }]
    },

    banner: {
        imageUrl: { type: String, default: '' },
        altText:  { type: String, default: '' }
    },

    salesBanner: {
        active:          { type: Boolean, default: false },
        imageUrl:        { type: String, default: '' },
        headline:        { type: String, default: '' },
        subtext:         { type: String, default: '' },
        ctaLabel:        { type: String, default: '' },
        ctaUrl:          { type: String, default: '' },
        discountPercent: { type: Number, default: 0 },
        startsAt:        { type: Date },
        endsAt:          { type: Date },
        _alerted:        { type: Boolean, default: false }
    },

    returnPolicy:   { type: String, default: '' },
    shippingPolicy: { type: String, default: '' },
    responseTime:   { type: String, default: 'Within 24 hours' },

    tags:        { type: [String], default: [] },
    totalSales:  { type: Number, default: 0 },
    totalOrders: { type: Number, default: 0 },

    active:       { type: Boolean, default: true },
    pausedReason: { type: String, default: '' },
    lastActive:   { type: Date, default: Date.now },

    sellerAvgRating:   { type: Number, default: 0 },
    sellerReviewCount: { type: Number, default: 0 },
    replyRate:         { type: Number, default: 0 },

    minCodBuyerScore: { type: Number, default: 0, min: 0, max: 5 },

    fulfillmentOptions: {
        type:    [String],
        enum:    ['shipping', 'pickup', 'self_fulfilled'],
        default: ['shipping']
    },

    pickupLocations: [{
        label:        { type: String, required: true },
        street:       { type: String, required: true },
        city:         { type: String, default: '' },
        province:     { type: String, default: '' },
        postalCode:   { type: String, default: '' },
        country:      { type: String, default: 'Canada' },
        hours:        { type: String, default: '' },
        instructions: { type: String, default: '' },
        active:       { type: Boolean, default: true }
    }],

    enabledCarriers: {
        type:    [String],
        enum:    ['canada_post', 'ups', 'fedex', 'purolator', 'dhl', 'other'],
        default: ['canada_post', 'ups', 'fedex', 'purolator', 'dhl', 'other']
    },

    verified:    { type: Boolean, default: false },
    specialties: { type: [String], default: [] },

    // updated by analytics-service via seller.tier_updated event
    tier: { type: String, enum: ['standard', 'rising', 'top'], default: 'standard' },

    setupChecklist: {
        profilePhoto:       { type: Boolean, default: false },
        descriptionWritten: { type: Boolean, default: false },
        firstProductListed: { type: Boolean, default: false },
        firstSaleMade:      { type: Boolean, default: false },
        returnPolicySet:    { type: Boolean, default: false }
    },

    vacationMode: {
        active:    { type: Boolean, default: false },
        message:   { type: String, default: '' },
        resumesAt: Date
    },

    fulfillmentPenalties: [{
        reason:    String,
        orderId:   mongoose.Schema.Types.ObjectId,
        detail:    String,
        issuedAt:  { type: Date, default: Date.now }
    }],

    publicStats: {
        onTimeDeliveryRate:   { type: Number, default: 0 },
        avgResponseTimeHrs:   { type: Number, default: 0 },
        totalFulfilledOrders: { type: Number, default: 0 }
    },

    stripeConnectAccountId: { type: String, default: null },
    stripeConnectStatus:    { type: String, enum: ['not_connected', 'pending', 'active'], default: 'not_connected' },

    // Onboarding — false until seller completes Phase 2 store setup (name, phone, fulfillment)
    storeSetupDone: { type: Boolean, default: false },

    createdAt: { type: Date, default: Date.now }
});

const Store = db.model('Store', StoreSchema);

// ── Helpers ──────────────────────────────────────────────────────────────────

function computeOpenStatus(store) {
    if (store.isOpen === false) return { isOpen: false, nextOpen: null, closesAt: null };

    const now    = new Date();
    const days   = ['sun','mon','tue','wed','thu','fri','sat'];
    const dayKey = days[now.getDay()];
    const sch    = store.schedule;

    if (!sch || !sch[dayKey]) return { isOpen: store.isOpen !== false, nextOpen: null, closesAt: null };

    const todayConfig = sch[dayKey];

    if (!todayConfig.open) {
        let nextOpenStr = null;
        for (let i = 1; i <= 7; i++) {
            const nextDayKey = days[(now.getDay() + i) % 7];
            if (sch[nextDayKey]?.open) {
                const label = nextDayKey.charAt(0).toUpperCase() + nextDayKey.slice(1);
                nextOpenStr = `${label} ${sch[nextDayKey].openTime || '09:00'}`;
                break;
            }
        }
        return { isOpen: false, nextOpen: nextOpenStr, closesAt: null };
    }

    const [openH,  openM]  = (todayConfig.openTime  || '09:00').split(':').map(Number);
    const [closeH, closeM] = (todayConfig.closeTime || '18:00').split(':').map(Number);
    const openMins  = openH  * 60 + openM;
    const closeMins = closeH * 60 + closeM;
    const nowMins   = now.getHours() * 60 + now.getMinutes();
    const open      = nowMins >= openMins && nowMins < closeMins;

    return {
        isOpen:   open,
        nextOpen: open ? null : `Tomorrow ${todayConfig.openTime || '09:00'}`,
        closesAt: open ? (todayConfig.closeTime || '18:00') : null
    };
}

function activeSalesBanner(store) {
    const sb = store.salesBanner;
    if (!sb || !sb.active) return null;
    const now = new Date();
    if (sb.endsAt && new Date(sb.endsAt) < now) return null;
    if (sb.startsAt && new Date(sb.startsAt) > now) return null;
    return sb;
}

// ── Event listeners ──────────────────────────────────────────────────────────

bus.on('user.deleted', async (payload) => {
    try {
        const result = await Store.deleteMany({ sellerId: payload.userId });
        console.log(`[SELLER] Removed ${result.deletedCount} store records for seller ${payload.userId}`);
    } catch (err) { console.error('[SELLER] user.deleted cleanup error:', err.message); }
});

bus.on('user.pending_deletion', async (payload) => {
    try {
        const store = await Store.findOneAndUpdate(
            { sellerId: payload.userId },
            { active: false, pausedReason: 'account_pending_deletion' },
            { new: true }
        );
        if (store) console.log(`[SELLER] Store paused for pending deletion: sellerId=${payload.userId}`);
    } catch (err) { console.error('[SELLER] user.pending_deletion pause error:', err.message); }
});

bus.on('user.deletion_cancelled', async (payload) => {
    try {
        const store = await Store.findOneAndUpdate(
            { sellerId: payload.userId, pausedReason: 'account_pending_deletion' },
            { active: true, pausedReason: '' },
            { new: true }
        );
        if (store) console.log(`[SELLER] Store restored after deletion cancelled: sellerId=${payload.userId}`);
    } catch (err) { console.error('[SELLER] user.deletion_cancelled restore error:', err.message); }
});

bus.on('payment.captured', async (payload) => {
    try {
        // payload carries sellerIds array; fallback to singular sellerId for older events
        const ids = payload.sellerIds || (payload.sellerId ? [payload.sellerId] : []);
        const amountCents = payload.amountCents ?? payload.amount ?? 0;
        for (const sid of ids) {
            await Store.findOneAndUpdate(
                { sellerId: sid },
                {
                    $inc: { totalOrders: 1, totalSales: amountCents },
                    $set: { 'setupChecklist.firstSaleMade': true }
                }
            );
        }
        console.log(`[SELLER] Order confirmed: orderId=${payload.orderId}, sellerIds=${ids.join(',')}`);
    } catch (err) { console.error('[SELLER] payment.captured stats error:', err.message); }
});

bus.on('seller.reviewed', async (payload) => {
    try {
        await Store.findOneAndUpdate(
            { sellerId: payload.sellerId },
            { sellerAvgRating: payload.avgRating, sellerReviewCount: payload.reviewCount }
        );
    } catch (err) { console.error('[SELLER] seller.reviewed error:', err.message); }
});

// sellerId is a userId, not storeId — must query by sellerId field, not _id
bus.on('seller.replied', async (payload) => {
    try {
        const res = await fetch(`http://localhost:5008/seller/${payload.sellerId}/stats`);
        if (res.ok) {
            const stats = await res.json();
            await Store.findOneAndUpdate(
                { sellerId: payload.sellerId },
                { replyRate: stats.replyRate || 0 }
            );
        }
    } catch (err) { console.error('[SELLER] seller.replied replyRate update error:', err.message); }
});

bus.on('product.created', async (payload) => {
    try {
        if (payload.sellerId) {
            await Store.findOneAndUpdate(
                { sellerId: payload.sellerId },
                { $set: { 'setupChecklist.firstProductListed': true } }
            );
        }
    } catch (err) { console.error('[SELLER] product.created checklist error:', err.message); }
});

bus.on('seller.tier_updated', async (payload) => {
    try {
        if (payload.sellerId && payload.tier) {
            await Store.findOneAndUpdate({ sellerId: payload.sellerId }, { tier: payload.tier });
            console.log(`[SELLER] Tier updated: sellerId=${payload.sellerId} → ${payload.tier}`);
        }
    } catch (err) { console.error('[SELLER] seller.tier_updated error:', err.message); }
});

bus.on('seller.fulfillment_penalty', async (payload) => {
    try {
        if (!payload.sellerId) return;
        const entry = {
            reason:   payload.reason   || 'unspecified',
            orderId:  payload.orderId  || null,
            detail:   payload.detail   || '',
            issuedAt: new Date()
        };
        await Store.findOneAndUpdate(
            { sellerId: payload.sellerId },
            { $push: { fulfillmentPenalties: { $each: [entry], $slice: -50 } } }
        );
        console.log(`[SELLER] Fulfillment penalty recorded for seller ${payload.sellerId}: ${entry.reason}`);
    } catch (err) { console.error('[SELLER] seller.fulfillment_penalty error:', err.message); }
});

bus.on('message.seller_response', async (payload) => {
    try {
        if (!payload.sellerId || !payload.responseTimeMs) return;
        const store = await Store.findOne({ sellerId: payload.sellerId });
        if (!store) return;
        const newHrs = payload.responseTimeMs / 3600000;
        const current = store.publicStats?.avgResponseTimeHrs || 0;
        const updated = current === 0 ? newHrs : (current * 0.9 + newHrs * 0.1); // exponential moving average
        await Store.findOneAndUpdate({ sellerId: payload.sellerId }, { 'publicStats.avgResponseTimeHrs': Math.round(updated * 10) / 10 });
    } catch (err) { console.error('[SELLER] message.seller_response error:', err.message); }
});

bus.on('order.status_updated', async (payload) => {
    try {
        if (!['delivered', 'picked_up', 'self_fulfilled'].includes(payload.status)) return;
        for (const sellerId of (payload.sellerIds || [])) {
            const store = await Store.findOne({ sellerId });
            if (!store) continue;
            const total  = (store.publicStats?.totalFulfilledOrders || 0) + 1;
            const currentRate = store.publicStats?.onTimeDeliveryRate || 0;
            // onTime is optional in the payload — absent means no rate change
            const onTime = payload.onTime;
            const newRate = onTime !== undefined
                ? Math.round(((currentRate * (total - 1) + (onTime ? 1 : 0)) / total) * 100) / 100
                : currentRate;
            await Store.findOneAndUpdate({ sellerId }, {
                'publicStats.totalFulfilledOrders': total,
                'publicStats.onTimeDeliveryRate':   newRate
            });
        }
    } catch (err) { console.error('[SELLER] order.status_updated publicStats error:', err.message); }
});

// ── Identity sync — respond to request.store_sync with all store mappings ────
// services emit this on startup to warm their storeId→sellerId cache without a direct DB connection
bus.on('request.store_sync', async () => {
    try {
        const stores = await Store.find({}).select('_id sellerId name').lean();
        for (const s of stores) {
            if (!s.sellerId) continue;
            bus.emit('store.cache_sync', {
                storeId:  s._id.toString(),
                sellerId: s.sellerId.toString(),
                storeName: s.name
            });
        }
        console.log(`[SELLER] store_sync: emitted ${stores.length} store mappings`);
    } catch (err) { console.error('[SELLER] store_sync error:', err.message); }
});

// ── Routes ───────────────────────────────────────────────────────────────────

app.post('/register', async (req, res) => {
    if (!req.user || !req.user.sub) return errorResponse(res, 401, 'Unauthorized');
    try {
        const existing = await Store.findById(req.user.storeId);
        if (existing) return res.json(existing);
        const store = await Store.create({
            _id:      req.user.storeId,
            sellerId: req.user.sub,
            ...req.body
        });
        res.status(201).json(store);
    } catch (err) { errorResponse(res, 500, err.message); }
});

// MUST be before /:storeId to avoid param capture
app.post('/admin/:storeId/verify', async (req, res) => {
    if (!req.headers['x-admin-email'] && req.user?.role !== 'admin') return errorResponse(res, 403, 'Admin only');
    try {
        const store = await Store.findByIdAndUpdate(req.params.storeId, { verified: true }, { new: true });
        if (!store) return errorResponse(res, 404, 'Store not found');
        bus.emit('store.verified', { storeId: store._id.toString(), storeName: store.name, sellerId: store.sellerId.toString() });
        res.json(store);
    } catch (err) { errorResponse(res, 500, err.message); }
});

app.post('/admin/:storeId/unverify', async (req, res) => {
    if (!req.headers['x-admin-email'] && req.user?.role !== 'admin') return errorResponse(res, 403, 'Admin only');
    try {
        const store = await Store.findByIdAndUpdate(req.params.storeId, { verified: false }, { new: true });
        if (!store) return errorResponse(res, 404, 'Store not found');
        bus.emit('store.unverified', { storeId: store._id.toString(), storeName: store.name });
        res.json(store);
    } catch (err) { errorResponse(res, 500, err.message); }
});

app.post('/admin/:storeId/suspend', async (req, res) => {
    if (!req.headers['x-admin-email'] && req.user?.role !== 'admin') return errorResponse(res, 403, 'Admin only');
    try {
        const { reason } = req.body;
        const store = await Store.findByIdAndUpdate(
            req.params.storeId,
            { active: false, suspendedAt: new Date(), suspendReason: reason || '' },
            { new: true }
        );
        if (!store) return errorResponse(res, 404, 'Store not found');
        bus.emit('store.suspended', { storeId: store._id.toString(), storeName: store.name, reason: reason || '' });
        res.json({ success: true, store });
    } catch (err) { errorResponse(res, 500, err.message); }
});

app.post('/admin/:storeId/restore', async (req, res) => {
    if (!req.headers['x-admin-email'] && req.user?.role !== 'admin') return errorResponse(res, 403, 'Admin only');
    try {
        const store = await Store.findByIdAndUpdate(
            req.params.storeId,
            { active: true, suspendedAt: null, suspendReason: '' },
            { new: true }
        );
        if (!store) return errorResponse(res, 404, 'Store not found');
        bus.emit('store.restored', { storeId: store._id.toString(), storeName: store.name });
        res.json({ success: true, store });
    } catch (err) { errorResponse(res, 500, err.message); }
});

app.get('/admin/stores', async (req, res) => {
    if (!req.headers['x-admin-email'] && req.user?.role !== 'admin') return errorResponse(res, 403, 'Admin only');
    try {
        const { verified, tier, active, from, to, page = 1, limit = 50 } = req.query;
        const query = {};
        if (verified !== undefined) query.verified = verified === 'true';
        if (tier)     query.tier   = tier;
        if (active !== undefined)   query.active  = active === 'true';
        if (from || to) query.createdAt = { ...(from && { $gte: new Date(from) }), ...(to && { $lte: new Date(to) }) };
        const skip  = (parseInt(page) - 1) * parseInt(limit);
        const lim   = Math.min(parseInt(limit), 100);
        const total = await Store.countDocuments(query);
        const stores = await Store.find(query).sort({ createdAt: -1 }).skip(skip).limit(lim);
        res.json({ stores, total, page: parseInt(page), hasMore: skip + lim < total });
    } catch (err) { errorResponse(res, 500, err.message); }
});

app.get('/on-sale-stores', async (req, res) => {
    try {
        const now = new Date();
        const stores = await Store.find({
            active: true,
            'salesBanner.active': true,
            $or: [
                { 'salesBanner.endsAt': { $exists: false } },
                { 'salesBanner.endsAt': null },
                { 'salesBanner.endsAt': { $gt: now } }
            ]
        }).select('_id name salesBanner').lean();
        const live = stores.filter(s => !s.salesBanner.startsAt || new Date(s.salesBanner.startsAt) <= now);
        res.json(live);
    } catch (err) { res.json([]); }
});

app.get('/by-seller/:id', async (req, res) => {
    try {
        const store = await Store.findOne({ sellerId: req.params.id, active: { $ne: false } });
        if (!store) return errorResponse(res, 404, 'Store not found');

        const { isOpen, nextOpen, closesAt } = computeOpenStatus(store);
        const sb = activeSalesBanner(store);

        res.json({
            _id:              store._id,
            name:             store.name        || 'Official Seller',
            description:      store.description || '',
            phone:            store.phone       || null,
            isOpen,
            nextOpen:         nextOpen  || null,
            closesAt:         closesAt  || null,
            schedule:         store.schedule,
            businessHours:    store.businessHours,
            responseTime:     store.responseTime,
            totalSales:       store.totalSales,
            totalOrders:      store.totalOrders,
            tags:             store.tags,
            specialties:      store.specialties  || [],
            verified:         store.verified     || false,
            tier:             store.tier         || 'standard',
            discount:         store.discount,
            banner:           store.banner,
            salesBanner:      sb,
            returnPolicy:     store.returnPolicy,
            shippingPolicy:   store.shippingPolicy,
            lastActive:       store.lastActive,
            createdAt:        store.createdAt,
            sellerAvgRating:  store.sellerAvgRating  || 0,
            sellerReviewCount:store.sellerReviewCount || 0,
            replyRate:        store.replyRate         || 0,
            fulfillmentOptions: store.fulfillmentOptions || ['shipping'],
            minCodBuyerScore:   store.minCodBuyerScore  || 0,
            publicStats:        store.publicStats || {},
            pickupLocations:    store.pickupLocations   || [],
            enabledCarriers:    store.enabledCarriers   || [],
            vacationMode: store.vacationMode?.active
                ? { active: true, message: store.vacationMode.message || '', resumesAt: store.vacationMode.resumesAt }
                : { active: false }
        });
    } catch (err) { errorResponse(res, 500, err.message); }
});

// ── Pickup Locations CRUD ─────────────────────────────────────────────────────

const PICKUP_ALLOWED = ['label', 'street', 'city', 'province', 'postalCode', 'country', 'hours', 'instructions', 'active'];

function validatePickup(body) {
    if (!body.label?.trim())  return 'label is required';
    if (!body.street?.trim()) return 'street is required';
    if (!body.city?.trim())   return 'city is required';
    return null;
}

// GET /:storeId/pickup-locations
app.get('/:storeId/pickup-locations', async (req, res) => {
    try {
        const store = await Store.findById(req.params.storeId);
        if (!store) return res.json([]); // store not yet created — return empty list
        res.json(store.pickupLocations || []);
    } catch (err) { errorResponse(res, 500, err.message); }
});

// POST /:storeId/pickup-locations
app.post('/:storeId/pickup-locations', async (req, res) => {
    if (!req.user || req.user.storeId !== req.params.storeId) return errorResponse(res, 403, 'Forbidden');
    const err = validatePickup(req.body);
    if (err) return errorResponse(res, 400, err);
    try {
        // auto-create stub store for users who registered before seller onboarding existed
        let store = await Store.findById(req.params.storeId);
        if (!store) {
            store = await Store.create({
                _id:      req.params.storeId,
                sellerId: req.user.sub,
                name:     'My Store'
            });
            console.log(`[SELLER] Auto-created stub store for storeId=${req.params.storeId}`);
        }
        const data = {};
        for (const k of PICKUP_ALLOWED) if (req.body[k] !== undefined) data[k] = req.body[k];
        store.pickupLocations.push(data);
        await store.save();
        res.status(201).json(store.pickupLocations);
    } catch (e) { errorResponse(res, 500, e.message); }
});

// PUT /:storeId/pickup-locations/:locationId
app.put('/:storeId/pickup-locations/:locationId', async (req, res) => {
    if (!req.user || req.user.storeId !== req.params.storeId) return errorResponse(res, 403, 'Forbidden');
    const err = validatePickup(req.body);
    if (err) return errorResponse(res, 400, err);
    try {
        const store = await Store.findById(req.params.storeId);
        if (!store) return res.json([]);
        const loc = store.pickupLocations.id(req.params.locationId);
        if (!loc) return errorResponse(res, 404, 'Pickup location not found');
        for (const k of PICKUP_ALLOWED) if (req.body[k] !== undefined) loc[k] = req.body[k];
        await store.save();
        res.json(store.pickupLocations);
    } catch (e) { errorResponse(res, 500, e.message); }
});

// DELETE /:storeId/pickup-locations/:locationId
app.delete('/:storeId/pickup-locations/:locationId', async (req, res) => {
    if (!req.user || req.user.storeId !== req.params.storeId) return errorResponse(res, 403, 'Forbidden');
    try {
        const store = await Store.findById(req.params.storeId);
        if (!store) return errorResponse(res, 404, 'Store not found');
        store.pickupLocations.pull(req.params.locationId);
        await store.save();
        res.json(store.pickupLocations);
    } catch (e) { errorResponse(res, 500, e.message); }
});

app.get('/:storeId', async (req, res) => {
    try {
        const store = await Store.findById(req.params.storeId);
        if (!store) return errorResponse(res, 404, 'Store not found');
        const { isOpen, nextOpen, closesAt } = computeOpenStatus(store);
        const sb = activeSalesBanner(store);
        const doc = store.toObject();
        doc.isOpen   = isOpen;
        doc.nextOpen = nextOpen  || null;
        doc.closesAt = closesAt  || null;
        if (!sb) doc.salesBanner = null;
        res.json(doc);
    } catch (err) { errorResponse(res, 500, err.message); }
});

app.put('/:storeId', async (req, res) => {
    if (!req.user || req.user.storeId !== req.params.storeId) {
        return errorResponse(res, 403, 'StoreId claim validation failed');
    }
    try {
        const existing = await Store.findById(req.params.storeId);
        if (!existing) return errorResponse(res, 404, 'Store not found');

        const wasOpen     = existing.isOpen !== false;
        const hadSale     = !!(existing.salesBanner?.active);
        const hadDiscount = !!(existing.discount?.storeWide?.enabled);
        const wasVacation = !!(existing.vacationMode?.active);

        const updated = await Store.findByIdAndUpdate(
            req.params.storeId,
            { ...req.body, lastActive: new Date() },
            { new: true }
        );

        const checklistUpdate = {};
        if (req.body.description?.trim()) checklistUpdate['setupChecklist.descriptionWritten'] = true;
        if (req.body.returnPolicy?.trim()) checklistUpdate['setupChecklist.returnPolicySet']    = true;
        if (req.body.banner?.imageUrl)     checklistUpdate['setupChecklist.profilePhoto']       = true;
        if (Object.keys(checklistUpdate).length) {
            await Store.findByIdAndUpdate(req.params.storeId, { $set: checklistUpdate });
        }

        const nowVacation = !!(updated.vacationMode?.active);
        if (!wasVacation && nowVacation) {
            bus.emit('store.vacation_started', {
                storeId:   updated._id.toString(),
                storeName: updated.name,
                message:   updated.vacationMode.message || '',
                resumesAt: updated.vacationMode.resumesAt
            });
        } else if (wasVacation && !nowVacation) {
            bus.emit('store.vacation_ended', { storeId: updated._id.toString(), storeName: updated.name });
        }

        if (!wasOpen && updated.isOpen !== false) {
            bus.emit('store.reopened', { storeId: updated._id.toString(), storeName: updated.name });
        }

        if (!hadSale && updated.salesBanner?.active) {
            bus.emit('store.sale_started', {
                storeId:         updated._id.toString(),
                storeName:       updated.name,
                headline:        updated.salesBanner.headline,
                discountPercent: updated.salesBanner.discountPercent,
                endsAt:          updated.salesBanner.endsAt
            });
        }

        if (!hadDiscount && updated.discount?.storeWide?.enabled) {
            bus.emit('store.discount_activated', {
                storeId:         updated._id.toString(),
                storeName:       updated.name,
                discountPercent: updated.discount.storeWide.percent
            });
        }

        const nameChanged = req.body.name        !== undefined && req.body.name        !== existing.name;
        const descChanged = req.body.description !== undefined && req.body.description !== existing.description;
        if (nameChanged || descChanged) {
            bus.emit('store.updated', {
                sellerId:         updated.sellerId.toString(),
                storeId:          updated._id.toString(),
                storeName:        updated.name,
                storeDescription: updated.description || ''
            });
        }

        res.json(updated);
    } catch (err) { errorResponse(res, 500, err.message); }
});

app.post('/:storeId/activate', async (req, res) => {
    if (!req.user || req.user.storeId !== req.params.storeId) return errorResponse(res, 403, 'StoreId claim validation failed');
    try {
        const store = await Store.findByIdAndUpdate(req.params.storeId, { active: true }, { new: true });
        if (!store) return errorResponse(res, 404, 'Store not found');
        bus.emit('seller.reactivated', { sellerId: store.sellerId.toString(), storeId: store._id.toString() });
        res.json({ message: 'Storefront activated. Refresh your token to receive seller capabilities.', store });
    } catch (err) { errorResponse(res, 500, err.message); }
});

app.post('/:storeId/deactivate', async (req, res) => {
    if (!req.user || req.user.storeId !== req.params.storeId) return errorResponse(res, 403, 'StoreId claim validation failed');
    try {
        const store = await Store.findByIdAndUpdate(req.params.storeId, { active: false }, { new: true });
        if (!store) return errorResponse(res, 404, 'Store not found');
        bus.emit('seller.deactivated', { sellerId: store.sellerId.toString(), storeId: store._id.toString() });
        res.json({ message: 'Storefront deactivated. Refresh your token to reflect the change.', store });
    } catch (err) { errorResponse(res, 500, err.message); }
});

// ── Hourly: "Sale ending soon" notification emission ─────────────────────────
setInterval(async () => {
    try {
        const now   = new Date();
        const in25h = new Date(now.getTime() + 25 * 60 * 60 * 1000);
        const in23h = new Date(now.getTime() + 23 * 60 * 60 * 1000);
        const stores = await Store.find({
            'salesBanner.active':   true,
            'salesBanner.endsAt':   { $gt: in23h, $lt: in25h },
            'salesBanner._alerted': { $ne: true }
        });
        for (const store of stores) {
            bus.emit('store.sale_ending_soon', {
                storeId:         store._id.toString(),
                storeName:       store.name,
                discountPercent: store.salesBanner.discountPercent,
                endsAt:          store.salesBanner.endsAt
            });
            await Store.updateOne({ _id: store._id }, { 'salesBanner._alerted': true });
        }
    } catch (err) { console.error('[SELLER] sale_ending_soon interval error:', err.message); }
}, 60 * 60 * 1000);

// ── Admin Routes ─────────────────────────────────────────────────────────────

// PATCH /admin/:storeId/tier — override seller tier
app.patch('/admin/:storeId/tier', async (req, res) => {
    if (!req.headers['x-admin-email'] && req.user?.role !== 'admin') return errorResponse(res, 403, 'Admin only');
    const { tier, reason } = req.body;
    if (!['standard', 'rising', 'top'].includes(tier)) return errorResponse(res, 400, 'tier must be standard, rising, or top');
    try {
        const store = await Store.findByIdAndUpdate(req.params.storeId, { tier }, { new: true });
        if (!store) return errorResponse(res, 404, 'Store not found');
        bus.emit('store.tier_changed', { storeId: store._id.toString(), tier, reason: reason || '' });
        res.json({ success: true, storeId: store._id, tier, reason: reason || '' });
    } catch (err) { errorResponse(res, 500, err.message); }
});

app.get('/admin/stores/dormant', async (req, res) => {
    if (!req.headers['x-admin-email'] && req.user?.role !== 'admin') return errorResponse(res, 403, 'Admin only');
    try {
        const cutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
        const query = { active: true, lastActive: { $lt: cutoff } };
        const stores = await Store.find(query).sort({ lastActive: 1 });
        res.json({ stores, total: stores.length });
    } catch (err) { errorResponse(res, 500, err.message); }
});

app.get('/analytics', async (req, res) => {
    try {
        const storeId = req.user?.storeId;
        if (!storeId) return errorResponse(res, 401, 'Seller authentication required');

        const store = await Store.findById(storeId).select('totalSales totalOrders').lean();
        if (!store) return errorResponse(res, 404, 'Store not found');

        const pmPort = process.env.PAYMENT_PORT || 5004;
        let pendingPayouts = 0;
        try {
            const pmRes = await fetch(`http://localhost:${pmPort}/seller-summary/${storeId}`);
            if (pmRes.ok) {
                const data = await pmRes.json();
                pendingPayouts = data.pendingPayouts || 0;
            }
        } catch (e) {
            console.warn('[seller/analytics] pendingPayouts fetch failed:', e.message);
        }

        res.json({
            totalSales:    store.totalSales    || 0,
            totalOrders:   store.totalOrders   || 0,
            pendingPayouts,
        });
    } catch (err) { errorResponse(res, 500, err.message); }
});

app.get('/admin/stores/:storeId/profile', async (req, res) => {
    if (!req.headers['x-admin-email'] && req.user?.role !== 'admin') return errorResponse(res, 403, 'Admin only');
    try {
        const store = await Store.findById(req.params.storeId);
        if (!store) return errorResponse(res, 404, 'Store not found');
        res.json(store);
    } catch (err) { errorResponse(res, 500, err.message); }
});

app.get('/connect-status', async (req, res) => {
    try {
        const storeId = req.user?.storeId;
        if (!storeId) return errorResponse(res, 401, 'Seller authentication required');
        const store = await Store.findById(storeId).select('stripeConnectStatus stripeConnectAccountId').lean();
        if (!store) return errorResponse(res, 404, 'Store not found');
        res.json({
            stripeConnectStatus:    store.stripeConnectStatus    || 'not_connected',
            stripeConnectAccountId: store.stripeConnectAccountId || null,
        });
    } catch (err) { errorResponse(res, 500, err.message); }
});

app.patch('/admin/stores/:storeId/connect-status', async (req, res) => {
    if (!req.headers['x-admin-email'] && req.user?.role !== 'admin') return errorResponse(res, 403, 'Admin only');
    const VALID_STATUSES = ['not_connected', 'pending', 'active'];
    const { stripeConnectStatus, stripeConnectAccountId } = req.body;
    if (!stripeConnectStatus || !VALID_STATUSES.includes(stripeConnectStatus)) {
        return errorResponse(res, 400, `stripeConnectStatus must be one of: ${VALID_STATUSES.join(', ')}`);
    }
    try {
        const update = { stripeConnectStatus };
        if (stripeConnectAccountId !== undefined) update.stripeConnectAccountId = stripeConnectAccountId || null;
        const store = await Store.findByIdAndUpdate(req.params.storeId, update, { new: true, runValidators: true })
            .select('stripeConnectStatus stripeConnectAccountId').lean();
        if (!store) return errorResponse(res, 404, 'Store not found');
        res.json({ stripeConnectStatus: store.stripeConnectStatus, stripeConnectAccountId: store.stripeConnectAccountId });
    } catch (err) { errorResponse(res, 500, err.message); }
});


app.listen(process.env.PORT || 5005, () => console.log(`Seller Service on port ${process.env.PORT || 5005}`));
