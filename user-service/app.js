require('dotenv').config({ path: require('path').join(__dirname, '.env') });
const express  = require('express');
const mongoose = require('mongoose');
const cors     = require('cors');
const errorResponse = require('../shared/utils/errorResponse');
const parseUser     = require('../shared/middleware/parseUser');
const platformGuard = require('../shared/middleware/platformGuard');
const bus           = require('../shared/eventBus');

const app = express();
app.use(express.json());
app.use(cors());
app.use(parseUser);
app.use(platformGuard);

const db = mongoose.createConnection(process.env.MONGODB_URI);
db.on('connected', () => console.log('User Service DB Connected'));
db.on('error',     (err) => console.error('[USER] DB error:', err.message));

app.get('/health', (req, res) => {
    res.json({ service: 'user-service', status: 'ok', dbState: db.readyState === 1 ? 'connected' : 'disconnected' });
});

// ── Schema ───────────────────────────────────────────────────────────────────

const AddressSchema = new mongoose.Schema({
    label:      { type: String, enum: ['Home', 'Work', 'Other'], default: 'Home' },
    street:     { type: String, default: '' },
    city:       { type: String, default: '' },
    province:   { type: String, default: '' },
    postalCode: { type: String, default: '' },
    country:    { type: String, default: 'Canada' },
    isDefault:  { type: Boolean, default: false }
});

const ProfileSchema = new mongoose.Schema({
    userId:      { type: mongoose.Schema.Types.ObjectId, required: true, unique: true },
    storeId:     { type: mongoose.Schema.Types.ObjectId }, // populated from user.registered; required for hard-delete payload
    email:       { type: String, default: '' },            // denormalized from user.registered for admin search
    displayName: { type: String, default: '' },
    phone:       { type: String, default: '' },
    avatarUrl:   { type: String, default: '' },
    bio:         { type: String, default: '' },

    addresses: [AddressSchema],

    watchlist: [{
        productId: { type: mongoose.Schema.Types.ObjectId, required: true },
        addedAt:   { type: Date, default: Date.now }
    }],

    likedProducts: [{
        productId: { type: mongoose.Schema.Types.ObjectId, required: true },
        likedAt:   { type: Date, default: Date.now }
    }],

    notificationPreferences: {
        orderConfirmation:    { type: Boolean, default: true },
        shipmentUpdates:      { type: Boolean, default: true },
        reviewApproved:       { type: Boolean, default: true },
        stockAlerts:          { type: Boolean, default: true },
        payoutNotifications:  { type: Boolean, default: true }
    },

    // Buyer reputation (A.8)
    buyerScore:     { type: Number, default: 50, min: 0, max: 100 },
    reviewsWritten: { type: Number, default: 0 },

    createdAt: { type: Date, default: Date.now },
    updatedAt: { type: Date, default: Date.now },

    // Soft-delete fields — populated by user.self_deleted event
    softDeleted:    { type: Boolean, default: false },
    pendingDeletion: { type: Boolean, default: false },
    deletedAt:      { type: Date },
    originalEmail:  { type: String }, // stored in DB only, never emitted or returned to non-super callers
});

// No explicit index needed, unique: true on the field suffices.
// ProfileSchema.index({ userId: 1 }, { unique: true });
ProfileSchema.index({ 'watchlist.productId': 1 });
ProfileSchema.index({ 'likedProducts.productId': 1 });
ProfileSchema.index({ email: 1 });
ProfileSchema.index({ displayName: 1 });

const Profile = db.model('Profile', ProfileSchema);

// ── Event listeners ──────────────────────────────────────────────────────────

bus.on('user.registered', async (payload) => {
    try {
        const existing = await Profile.findOne({ userId: payload.userId });
        if (existing) return; // idempotent
        await Profile.create({
            userId:      payload.userId,
            storeId:     payload.storeId || null,
            email:       payload.email       || '',
            displayName: payload.displayName || '',
            phone:       payload.phone       || ''
        });
        console.log(`[USER] Profile created for userId ${payload.userId}`);
    } catch (err) { console.error('[USER] user.registered error:', err.message); }
});

bus.on('user.deleted', async (payload) => {
    try {
        const result = await Profile.deleteOne({ userId: payload.userId });
        console.log(`[USER] Deleted ${result.deletedCount} profile(s) for userId ${payload.userId}`);
    } catch (err) { console.error('[USER] user.deleted cleanup error:', err.message); }
});

bus.on('user.self_deleted', async (payload) => {
    try {
        await Profile.findOneAndUpdate(
            { userId: payload.userId },
            { softDeleted: true, pendingDeletion: false, deletedAt: payload.deletedAt, originalEmail: payload.originalEmail || '' }
        );
        console.log(`[USER] Marked profile as soft-deleted for userId ${payload.userId}`);
    } catch (err) { console.error('[USER] user.self_deleted error:', err.message); }
});

bus.on('user.pending_deletion', async (payload) => {
    try {
        await Profile.findOneAndUpdate({ userId: payload.userId }, { pendingDeletion: true });
        console.log(`[USER] Marked profile as pending deletion for userId ${payload.userId}`);
    } catch (err) { console.error('[USER] user.pending_deletion error:', err.message); }
});

bus.on('user.deletion_cancelled', async (payload) => {
    try {
        await Profile.findOneAndUpdate({ userId: payload.userId }, { pendingDeletion: false });
        console.log(`[USER] Cleared pending deletion for userId ${payload.userId}`);
    } catch (err) { console.error('[USER] user.deletion_cancelled error:', err.message); }
});

// A.8 — Increment buyerScore and reviewsWritten on each submitted review
bus.on('review.submitted', async (payload) => {
    try {
        const increment = (payload.qualityScore >= 50) ? 2 : 1;
        await Profile.findOneAndUpdate(
            { userId: payload.buyerId },
            { $inc: { reviewsWritten: 1, buyerScore: increment } }
        );
        // Hard cap at 100
        await Profile.updateOne(
            { userId: payload.buyerId, buyerScore: { $gt: 100 } },
            { buyerScore: 100 }
        );
    } catch (err) { console.error('[USER] review.submitted buyerScore error:', err.message); }
});

// ── Helper: get or create profile ────────────────────────────────────────────
async function getOrCreate(userId) {
    let profile = await Profile.findOne({ userId });
    if (!profile) {
        profile = await Profile.create({ userId });
    }
    return profile;
}

// ── Routes ───────────────────────────────────────────────────────────────────

// GET /users/me
app.get('/users/me', async (req, res) => {
    if (!req.user?.sub) return errorResponse(res, 401, 'Unauthorized');
    try {
        const profile = await getOrCreate(req.user.sub);
        res.json(profile);
    } catch (err) { errorResponse(res, 500, err.message); }
});

// PUT /users/me — partial update
app.put('/users/me', async (req, res) => {
    if (!req.user?.sub) return errorResponse(res, 401, 'Unauthorized');
    const allowed = ['displayName', 'phone', 'avatarUrl', 'bio', 'notificationPreferences'];
    const update  = {};
    allowed.forEach(k => { if (req.body[k] !== undefined) update[k] = req.body[k]; });
    update.updatedAt = new Date();
    try {
        const profile = await Profile.findOneAndUpdate(
            { userId: req.user.sub },
            { $set: update },
            { new: true, upsert: true }
        );
        if (update.displayName !== undefined) {
            bus.emit('user.profile_updated', { userId: req.user.sub, displayName: update.displayName });
        }
        res.json(profile);
    } catch (err) { errorResponse(res, 500, err.message); }
});

// POST /users/me/addresses
app.post('/users/me/addresses', async (req, res) => {
    if (!req.user?.sub) return errorResponse(res, 401, 'Unauthorized');
    try {
        const profile = await getOrCreate(req.user.sub);
        if (req.body.isDefault) {
            profile.addresses.forEach(a => { a.isDefault = false; });
        }
        profile.addresses.push(req.body);
        profile.updatedAt = new Date();
        await profile.save();
        res.json(profile.addresses);
    } catch (err) { errorResponse(res, 500, err.message); }
});

// PUT /users/me/addresses/:addressId
app.put('/users/me/addresses/:addressId', async (req, res) => {
    if (!req.user?.sub) return errorResponse(res, 401, 'Unauthorized');
    try {
        const profile = await getOrCreate(req.user.sub);
        const addr    = profile.addresses.id(req.params.addressId);
        if (!addr) return errorResponse(res, 404, 'Address not found');
        if (req.body.isDefault) {
            profile.addresses.forEach(a => { a.isDefault = false; });
        }
        Object.assign(addr, req.body);
        profile.updatedAt = new Date();
        await profile.save();
        res.json(profile.addresses);
    } catch (err) { errorResponse(res, 500, err.message); }
});

// DELETE /users/me/addresses/:addressId
app.delete('/users/me/addresses/:addressId', async (req, res) => {
    if (!req.user?.sub) return errorResponse(res, 401, 'Unauthorized');
    try {
        const profile = await getOrCreate(req.user.sub);
        profile.addresses.pull(req.params.addressId);
        profile.updatedAt = new Date();
        await profile.save();
        res.json(profile.addresses);
    } catch (err) { errorResponse(res, 500, err.message); }
});

// POST /users/me/watchlist/:productId
app.post('/users/me/watchlist/:productId', async (req, res) => {
    if (!req.user?.sub) return errorResponse(res, 401, 'Unauthorized');
    try {
        const profile = await getOrCreate(req.user.sub);
        const alreadyIn = profile.watchlist.some(w => w.productId.toString() === req.params.productId);
        if (!alreadyIn) {
            profile.watchlist.push({ productId: req.params.productId });
            profile.updatedAt = new Date();
            await profile.save();
            bus.emit('user.watchlist_added', { userId: req.user.sub, productId: req.params.productId, timestamp: profile.updatedAt });
        }
        res.json(profile.watchlist);
    } catch (err) { errorResponse(res, 500, err.message); }
});

// DELETE /users/me/watchlist/:productId
app.delete('/users/me/watchlist/:productId', async (req, res) => {
    if (!req.user?.sub) return errorResponse(res, 401, 'Unauthorized');
    try {
        const profile = await getOrCreate(req.user.sub);
        profile.watchlist = profile.watchlist.filter(w => w.productId.toString() !== req.params.productId);
        profile.updatedAt = new Date();
        await profile.save();
        bus.emit('user.watchlist_removed', { userId: req.user.sub, productId: req.params.productId, timestamp: profile.updatedAt });
        res.json(profile.watchlist);
    } catch (err) { errorResponse(res, 500, err.message); }
});

// A.8 — Buyer score: seller calls this to assess COD risk on a buyer's order.
// Requires a valid seller token — anonymous callers cannot query buyer scores.
app.get('/users/:userId/buyer-score', async (req, res) => {
    if (!req.user?.sub) return errorResponse(res, 401, 'Unauthorized');
    const isSeller = req.user.storeActive === true;
    const isAdmin  = req.user.role === 'admin';
    if (!isSeller && !isAdmin) return errorResponse(res, 403, 'Seller access required');
    try {
        const profile = await Profile.findOne({ userId: req.params.userId });
        res.json({ buyerScore: profile?.buyerScore ?? 50, reviewsWritten: profile?.reviewsWritten ?? 0 });
    } catch (err) { errorResponse(res, 500, err.message); }
});

// Internal route — returns notificationPreferences for a user (used by notification-service before sending emails)
app.get('/users/:userId/prefs', async (req, res) => {
    try {
        const profile = await Profile.findOne({ userId: req.params.userId });
        if (!profile) return res.json({});
        res.json(profile.notificationPreferences || {});
    } catch (err) { errorResponse(res, 500, err.message); }
});

// Internal route — monolith phase only. In multi-process deployment, requires service-to-service authentication.
app.get('/users/watching/:productId', async (req, res) => {
    try {
        const profiles = await Profile.find({ 'watchlist.productId': req.params.productId });
        const userIds = profiles.map(p => p.userId);
        res.json(userIds);
    } catch (err) { errorResponse(res, 500, err.message); }
});

// Internal route — returns all userIds watching any product from a given store.
// Steps: (1) fetch product IDs from catalog-service for that store, (2) find profiles watching any of those IDs.
app.get('/users/watching-store/:storeId', async (req, res) => {
    try {
        // Fetch the store's active product IDs from catalog-service (internal port)
        const catRes = await fetch(`http://localhost:5002/by-seller/${req.params.storeId}`).catch(() => null);
        if (!catRes || !catRes.ok) return res.json([]); // fail open
        const products = await catRes.json();
        if (!Array.isArray(products) || products.length === 0) return res.json([]);

        const productIds = products.map(p => p._id);
        const profiles = await Profile.find({ 'watchlist.productId': { $in: productIds } });
        const userIds = [...new Set(profiles.map(p => p.userId.toString()))];
        res.json(userIds);
    } catch (err) { errorResponse(res, 500, err.message); }
});

// GET /users/me/watchlist
app.get('/users/me/watchlist', async (req, res) => {
    if (!req.user?.sub) return errorResponse(res, 401, 'Unauthorized');
    try {
        const profile = await getOrCreate(req.user.sub);
        res.json(profile.watchlist);
    } catch (err) { errorResponse(res, 500, err.message); }
});

// POST /users/me/likes/:productId
app.post('/users/me/likes/:productId', async (req, res) => {
    if (!req.user?.sub) return errorResponse(res, 401, 'Unauthorized');
    try {
        const profile = await getOrCreate(req.user.sub);
        const alreadyIn = profile.likedProducts.some(l => l.productId.toString() === req.params.productId);
        if (!alreadyIn) {
            profile.likedProducts.push({ productId: req.params.productId });
            profile.updatedAt = new Date();
            await profile.save();
        }
        res.json(profile.likedProducts);
    } catch (err) { errorResponse(res, 500, err.message); }
});

// DELETE /users/me/likes/:productId
app.delete('/users/me/likes/:productId', async (req, res) => {
    if (!req.user?.sub) return errorResponse(res, 401, 'Unauthorized');
    try {
        const profile = await getOrCreate(req.user.sub);
        profile.likedProducts = profile.likedProducts.filter(l => l.productId.toString() !== req.params.productId);
        profile.updatedAt = new Date();
        await profile.save();
        res.json(profile.likedProducts);
    } catch (err) { errorResponse(res, 500, err.message); }
});

// GET /users/:userId — admin only
app.get('/users/:userId', async (req, res) => {
    if (!req.user?.sub) return errorResponse(res, 401, 'Unauthorized');
    if (req.user.role !== 'admin') return errorResponse(res, 403, 'Admin only');
    try {
        const profile = await Profile.findOne({ userId: req.params.userId });
        if (!profile) return errorResponse(res, 404, 'Profile not found');
        res.json(profile);
    } catch (err) { errorResponse(res, 500, err.message); }
});

// ── ADMIN ROUTES ──────────────────────────────────────────────────────────────

// GET /admin/users/lookup?ids=id1,id2,... — resolve userIds to display names (for order enrichment)
// MUST be declared before /admin/users/:userId to avoid param capture
app.get('/admin/users/lookup', async (req, res) => {
    if (!req.headers['x-admin-email']) return errorResponse(res, 403, 'Admin only');
    try {
        const ids = (req.query.ids || '').split(',').filter(Boolean);
        if (!ids.length) return res.json({});
        const profiles = await Profile.find(
            { userId: { $in: ids } },
            { userId: 1, displayName: 1, storeId: 1 }
        ).lean();
        const map = {};
        for (const p of profiles) map[p.userId.toString()] = { displayName: p.displayName || '', storeId: p.storeId?.toString() || '' };
        res.json(map);
    } catch (err) { errorResponse(res, 500, err.message); }
});

// GET /admin/users/deleted — list soft-deleted accounts (superuser only via proxy)
// MUST be declared before /admin/users/:userId to avoid param capture
app.get('/admin/users/deleted', async (req, res) => {
    if (!req.headers['x-admin-email']) return errorResponse(res, 403, 'Admin only');
    try {
        const { page = 1, limit = 50 } = req.query;
        const skip  = (parseInt(page) - 1) * parseInt(limit);
        const total = await Profile.countDocuments({ softDeleted: true });
        const users = await Profile.find({ softDeleted: true })
            .sort({ deletedAt: -1 })
            .skip(skip)
            .limit(parseInt(limit))
            .select('userId storeId displayName originalEmail deletedAt')
            .lean();
        res.json({ users, total, page: parseInt(page) });
    } catch (err) { errorResponse(res, 500, err.message); }
});

// GET /admin/users — list all profiles with optional filters (role, status, page, limit)
// Note: role and status are claims stored on the JWT / auth layer, not on the Profile document.
// We query Profile documents here and support page/limit pagination.
// role and status filters are passed through to a best-effort $match if those fields exist on the doc.
app.get('/admin/users', async (req, res) => {
    if (!req.user || req.user.role !== 'admin') return errorResponse(res, 403, 'Admin only');
    try {
        const { role, status, search, page = 1, limit = 50 } = req.query;
        const query = { softDeleted: { $ne: true } }; // hide soft-deleted from main list
        if (role)   query.role   = role;
        if (status) query.status = status;
        if (search) {
            const re = new RegExp(search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
            query.$or = [{ email: re }, { displayName: re }];
        }

        const skip  = (parseInt(page) - 1) * parseInt(limit);
        const total = await Profile.countDocuments(query);
        const users = await Profile.find(query)
            .sort({ createdAt: -1 })
            .skip(skip)
            .limit(parseInt(limit));

        res.json({ users, total, page: parseInt(page) });
    } catch (err) { errorResponse(res, 500, err.message); }
});

// PATCH /admin/users/:userId/suspend — set status to 'suspended'
// Body: { reason }
app.patch('/admin/users/:userId/suspend', async (req, res) => {
    if (!req.user || req.user.role !== 'admin') return errorResponse(res, 403, 'Admin only');
    try {
        const profile = await Profile.findOneAndUpdate(
            { userId: req.params.userId },
            { $set: { status: 'suspended', updatedAt: new Date() } },
            { new: true }
        );
        if (!profile) return errorResponse(res, 404, 'Profile not found');
        bus.emit('user.suspended', { userId: req.params.userId, reason: req.body.reason || null });
        res.json({ userId: req.params.userId, status: 'suspended' });
    } catch (err) { errorResponse(res, 500, err.message); }
});

// PATCH /admin/users/:userId/ban — hard ban, set status to 'banned'
// Body: { reason }
app.patch('/admin/users/:userId/ban', async (req, res) => {
    if (!req.user || req.user.role !== 'admin') return errorResponse(res, 403, 'Admin only');
    try {
        const profile = await Profile.findOneAndUpdate(
            { userId: req.params.userId },
            { $set: { status: 'banned', updatedAt: new Date() } },
            { new: true }
        );
        if (!profile) return errorResponse(res, 404, 'Profile not found');
        bus.emit('user.banned', { userId: req.params.userId, reason: req.body.reason || null });
        res.json({ userId: req.params.userId, status: 'banned' });
    } catch (err) { errorResponse(res, 500, err.message); }
});

// PATCH /admin/users/:userId/unban — lift ban, set status to 'active'
app.patch('/admin/users/:userId/unban', async (req, res) => {
    if (!req.user || req.user.role !== 'admin') return errorResponse(res, 403, 'Admin only');
    try {
        const profile = await Profile.findOneAndUpdate(
            { userId: req.params.userId },
            { $set: { status: 'active', updatedAt: new Date() } },
            { new: true }
        );
        if (!profile) return errorResponse(res, 404, 'Profile not found');
        bus.emit('user.unbanned', { userId: req.params.userId });
        res.json({ userId: req.params.userId, status: 'active' });
    } catch (err) { errorResponse(res, 500, err.message); }
});

// PATCH /admin/users/:userId/role — change role
// Body: { role: 'buyer'|'seller'|'admin', reason }
app.patch('/admin/users/:userId/role', async (req, res) => {
    if (!req.user || req.user.role !== 'admin') return errorResponse(res, 403, 'Admin only');
    const { role, reason } = req.body;
    const VALID_ROLES = ['buyer', 'seller', 'admin'];
    if (!role || !VALID_ROLES.includes(role)) {
        return errorResponse(res, 400, `role must be one of: ${VALID_ROLES.join(', ')}`);
    }
    try {
        const profile = await Profile.findOneAndUpdate(
            { userId: req.params.userId },
            { $set: { role, updatedAt: new Date() } },
            { new: true }
        );
        if (!profile) return errorResponse(res, 404, 'Profile not found');
        bus.emit('user.role_changed', { userId: req.params.userId, newRole: role, reason: reason || null });
        res.json({ userId: req.params.userId, role });
    } catch (err) { errorResponse(res, 500, err.message); }
});

// DELETE /admin/users/:userId — hard delete: fetch storeId, emit full cascade, then delete profile
// Body: { reason }
app.delete('/admin/users/:userId', async (req, res) => {
    if (!req.headers['x-admin-email']) return errorResponse(res, 403, 'Admin only');
    try {
        const profile = await Profile.findOne({ userId: req.params.userId });
        if (!profile) return errorResponse(res, 404, 'Profile not found');

        // storeId is critical for cascade — catalog, inventory, search all need it
        const storeId = profile.storeId?.toString();
        if (!storeId) {
            console.warn(`[USER] Hard-delete for userId ${req.params.userId} has no storeId — cascade may be incomplete`);
        }

        bus.emit('user.deleted', {
            userId:      req.params.userId,
            storeId:     storeId || null,
            reason:      req.body.reason || null,
            adminAction: true,
            hardDelete:  true
        });

        // Delete the profile itself
        await Profile.deleteOne({ userId: req.params.userId });

        res.json({ userId: req.params.userId, deleted: true });
    } catch (err) { errorResponse(res, 500, err.message); }
});



app.listen(process.env.PORT || 5013, () =>
    console.log(`User Service on port ${process.env.PORT || 5013}`)
);
