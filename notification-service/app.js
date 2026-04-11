require('dotenv').config({ path: require('path').join(__dirname, '.env') });
const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const nodemailer = require('nodemailer');
const parseUser = require('../shared/middleware/parseUser');
const platformGuard = require('../shared/middleware/platformGuard');
const errorResponse = require('../shared/utils/errorResponse');
const bus = require('../shared/eventBus');

const app = express();
app.use(express.json());
app.use(cors());
app.use(parseUser);
app.use(platformGuard);

const db = mongoose.createConnection(process.env.MONGODB_URI);
db.on('connected', () => console.log('Notification DB Connected'));
db.on('error', (err) => console.error('[NOTIFY] DB error:', err.message));

const NotificationSchema = new mongoose.Schema({
    type:       { type: String, required: true },
    recipient:  String, // email address (legacy field — keep for existing email log)
    subject:    String,
    body:       String,
    eventData:  mongoose.Schema.Types.Mixed,
    sentAt:     { type: Date, default: Date.now },
    // ── In-app notification fields (additive — do not break existing email log) ──
    userId:     mongoose.Schema.Types.ObjectId,  // actual userId from JWT sub
    channel:    { type: String, enum: ['email', 'in_app', 'both'], default: 'email' },
    read:       { type: Boolean, default: false },
    link:       String,   // e.g. /orders/:id
    icon:       String,   // e.g. fa-box, fa-tag, fa-comments
    priority:   { type: String, enum: ['low', 'medium', 'high', 'critical'], default: 'medium' }
});
const Notification = db.model('Notification', NotificationSchema);

// ── Mailer setup ─────────────────────────────────────────────────────────────
// Uses Ethereal (fake SMTP for dev). On first run, creates a test account if no credentials set.
let transporter = null;

async function getTransporter() {
    if (transporter) return transporter;

    let user = process.env.SMTP_USER;
    let pass = process.env.SMTP_PASS;

    if (!user || !pass) {
        // Auto-create Ethereal test account
        const testAccount = await nodemailer.createTestAccount();
        user = testAccount.user;
        pass = testAccount.pass;
        console.log('[NOTIFY] Ethereal test account created:', user);
        console.log('[NOTIFY] Preview emails at: https://ethereal.email');
    }

    transporter = nodemailer.createTransport({
        host: process.env.SMTP_HOST || 'smtp.ethereal.email',
        port: parseInt(process.env.SMTP_PORT) || 587,
        auth: { user, pass }
    });
    return transporter;
}

// inApp: { userId, link, icon, priority } — optional; when provided, notification is also stored for in-app display
async function sendNotification(type, recipient, subject, body, eventData, inApp = null) {
    // Dedup: skip if same type+userId notification exists within 24h
    if (inApp?.userId) {
        try {
            const recent = await Notification.findOne({
                type,
                userId: new mongoose.Types.ObjectId(inApp.userId.toString()),
                sentAt: { $gte: new Date(Date.now() - 24 * 60 * 60 * 1000) }
            });
            if (recent) return; // Already notified recently — skip duplicate
        } catch (dedupErr) {
            // Dedup check failed — proceed with notification (fail open)
        }
    }

    const doc = { type, recipient, subject, body, eventData, channel: 'email' };
    if (inApp?.userId) {
        doc.userId   = inApp.userId;
        doc.link     = inApp.link     || null;
        doc.icon     = inApp.icon     || 'fa-bell';
        doc.priority = inApp.priority || 'medium';
        doc.channel  = 'both';
    }

    try {
        const t = await getTransporter();
        const info = await t.sendMail({
            from:    '"Markee Marketplace" <noreply@markee.com>',
            to:      recipient,
            subject,
            text:    body
        });
        console.log(`[NOTIFY] Email sent: ${nodemailer.getTestMessageUrl(info) || info.messageId}`);
        await Notification.create(doc);
    } catch (err) {
        console.error('[NOTIFY] Email error:', err.message);
        // Still persist for in-app display even if email transport fails
        try { await Notification.create(doc); } catch {}
    }
}

// ── Notification preference gate ─────────────────────────────────────────────
// Fetches user notificationPreferences from user-service and returns true if the
// given notification type is allowed. Defaults to true on any fetch failure (fail open).
const PREF_KEY_MAP = {
    'ORDER_PLACED':            'orderConfirmation',
    'ORDER_ACCEPTED':          'orderConfirmation',
    'ORDER_CANCELLED_BUYER':   'orderConfirmation',
    'ORDER_INVENTORY_FAILED':  'orderConfirmation',
    'SHIPMENT_CREATED':        'shipmentUpdates',
    'DELIVERED_BUYER':         'shipmentUpdates',
    'DELIVERED_SELLER':        'payoutNotifications',
    'REVIEW_APPROVED':         'reviewApproved',
    'STOCK_LOW':               'stockAlerts',
    'MISSED_SALE':             'stockAlerts',
    'PAYMENT_CAPTURED':        'payoutNotifications',
    'PRICE_DROP_ALERT':        'shipmentUpdates', // reuse closest flag; welcome always sends
    'SALE_STARTED':               'stockAlerts',
    'SALE_ENDING_SOON':           'stockAlerts',
    'DISCOUNT_ACTIVATED':         'stockAlerts',
    'STORE_REOPENED':             'stockAlerts',
    'REVIEW_SUBMITTED_SELLER':    'reviewApproved',
    'SELLER_REPLIED_BUYER':       'reviewApproved',
    'REVIEW_NUDGE':               'orderConfirmation',
    'REVIEW_FLAGGED_ADMIN':       'stockAlerts',
};

async function isNotifAllowed(type, userId) {
    if (!userId) return true; // no userId to gate on — allow
    const prefKey = PREF_KEY_MAP[type];
    if (!prefKey) return true; // unknown type — allow
    try {
        const res = await fetch(`http://localhost:5013/users/${userId}/prefs`);
        if (!res.ok) return true;
        const profile = await res.json();
        const prefs = profile.notificationPreferences || {};
        // If preference key exists and is explicitly false, block it
        return prefs[prefKey] !== false;
    } catch {
        return true; // fail open — better to over-notify than silently drop
    }
}

// ── Event listener: recipient routing map ────────────────────────────────────
// A7: who gets what notification

bus.on('order.placed', async (payload) => {
    if (!await isNotifAllowed('ORDER_PLACED', payload.buyerId)) return;
    const buyerEmail = payload.buyerEmail || `buyer-${payload.buyerId}@markee.local`;
    await sendNotification(
        'ORDER_PLACED',
        buyerEmail,
        `Order Confirmed — #${payload.orderId?.toString().slice(-8).toUpperCase()}`,
        `Your order has been placed and payment is being processed.\n\nOrder ID: ${payload.orderId}\nTotal: $${((payload.totalAmount || 0) / 100).toFixed(2)}`,
        payload,
        { userId: payload.buyerId, link: `/orders/${payload.orderId}`, icon: 'fa-shopping-bag' }
    );
});

bus.on('payment.captured', async (payload) => {
    const sellerIds = Array.isArray(payload.sellerIds) ? payload.sellerIds
        : (payload.sellerId ? [payload.sellerId] : []);
    for (const sellerId of sellerIds) {
        if (!await isNotifAllowed('PAYMENT_CAPTURED', sellerId)) continue;
        const sellerEmail = `seller-${sellerId}@markee.local`;
        await sendNotification(
            'PAYMENT_CAPTURED',
            sellerEmail,
            `New Order Received — #${payload.orderId?.toString().slice(-8).toUpperCase()}`,
            `You have a new paid order!\n\nOrder ID: ${payload.orderId}\nAmount: $${((payload.amount || 0) / 100).toFixed(2)}\n\nLog in to Markee to ship the order.`,
            { ...payload, sellerId },
            { userId: sellerId, link: `/orders/${payload.orderId}`, icon: 'fa-box' }
        );
    }
});

bus.on('shipment.created', async (payload) => {
    if (!await isNotifAllowed('SHIPMENT_CREATED', payload.buyerId)) return;
    const buyerEmail = payload.buyerEmail || `buyer-${payload.buyerId}@markee.local`;
    await sendNotification(
        'SHIPMENT_CREATED',
        buyerEmail,
        `Your Order Has Shipped!`,
        `Great news! Your order is on the way.\n\nTracking Number: ${payload.trackingNumber || 'N/A'}\nCarrier: ${payload.carrier || 'Standard Shipping'}`,
        payload,
        { userId: payload.buyerId, link: `/orders/${payload.orderId}`, icon: 'fa-truck' }
    );
});

bus.on('shipment.delivered', async (payload) => {
    if (await isNotifAllowed('DELIVERED_BUYER', payload.buyerId)) {
        const buyerEmail = payload.buyerEmail || `buyer-${payload.buyerId}@markee.local`;
        await sendNotification(
            'DELIVERED_BUYER',
            buyerEmail,
            `Your Order Has Been Delivered`,
            `Your order has been delivered! You can now leave a review for the products you received.`,
            payload,
            { userId: payload.buyerId, link: `/orders/${payload.orderId}`, icon: 'fa-check-circle' }
        );
    }
    if (await isNotifAllowed('DELIVERED_SELLER', payload.sellerId)) {
        const sellerEmail = payload.sellerEmail || `seller-${payload.sellerId}@markee.local`;
        await sendNotification(
            'DELIVERED_SELLER',
            sellerEmail,
            `Payout Triggered for Order #${payload.orderId?.toString().slice(-8).toUpperCase()}`,
            `Order ${payload.orderId} has been delivered. Your payout has been released from escrow.`,
            payload,
            { userId: payload.sellerId, link: `/orders/${payload.orderId}`, icon: 'fa-money-bill-wave' }
        );
    }
});

bus.on('inventory.stock_low', async (payload) => {
    if (!await isNotifAllowed('STOCK_LOW', payload.sellerId)) return;
    const sellerEmail = payload.sellerEmail || `seller-${payload.sellerId}@markee.local`;
    await sendNotification(
        'STOCK_LOW',
        sellerEmail,
        `Low Stock Alert — "${payload.title || 'Product'}"`,
        `Your product "${payload.title || payload.productId}" has low stock.\n\nRemaining available: ${payload.quantity} units\n\nRestock now: /inventory`,
        payload,
        { userId: payload.sellerId, link: '/inventory', icon: 'fa-exclamation-triangle' }
    );
});

bus.on('review.approved', async (payload) => {
    if (!await isNotifAllowed('REVIEW_APPROVED', payload.buyerId)) return;
    const buyerEmail = payload.buyerEmail || `buyer-${payload.buyerId}@markee.local`;
    await sendNotification(
        'REVIEW_APPROVED',
        buyerEmail,
        `Your Review Has Been Published`,
        `Your review has been approved and is now live on the product page.`,
        payload,
        { userId: payload.buyerId, link: payload.productId ? `/product/${payload.productId}` : '/orders', icon: 'fa-star' }
    );
});

bus.on('order.inventory_failed', async (payload) => {
    // Buyer: item was out of stock — their order will be auto-cancelled, tell them now
    // buyerId is NOT in this payload (it's inventory-service, it doesn't know the buyer)
    // but orderId is — fetch the order to get buyerId
    try {
        const { orderId, reason, productId } = payload;
        if (!orderId) return;
        // Fetch order from order-service internal port to get buyerId
        const orderRes = await fetch(`http://localhost:5004/orders/${orderId}`).catch(() => null);
        let buyerId = null;
        if (orderRes?.ok) {
            const order = await orderRes.json();
            buyerId = order.buyerId;
        }
        const shortId = orderId.toString().slice(-8).toUpperCase();
        const buyerEmail = `buyer-${buyerId || 'unknown'}@markee.local`;
        await sendNotification(
            'ORDER_INVENTORY_FAILED',
            buyerEmail,
            `Order #${shortId} Cancelled — Item Unavailable`,
            `We're sorry — your order #${shortId} could not be processed.\n\nReason: ${reason || 'One or more items were out of stock.'}\n\nYou have not been charged. Please check our listings for alternatives.`,
            payload
        );
    } catch (err) {
        console.error('[NOTIFY] order.inventory_failed handler error:', err.message);
    }
});

bus.on('order.status_updated', async (payload) => {
    const { orderId, status, buyerId, items } = payload;
    const shortId = orderId?.toString().slice(-8).toUpperCase() || '???';

    if (status === 'cancelled') {
        // Buyer: silent cancellation — break the silence
        if (buyerId) {
            const buyerEmail = `buyer-${buyerId}@markee.local`;
            await sendNotification(
                'ORDER_CANCELLED_BUYER',
                buyerEmail,
                `Your Order #${shortId} Has Been Cancelled`,
                `Unfortunately, your order #${shortId} has been cancelled.\n\nIf you were charged, a refund will be processed automatically.\n\nLog in to view the details: /orders/${orderId}`,
                payload
            );
        }
    }

    if (status === 'processing') {
        // Buyer: seller accepted the COD order — let them know
        if (buyerId) {
            const buyerEmail = `buyer-${buyerId}@markee.local`;
            await sendNotification(
                'ORDER_ACCEPTED',
                buyerEmail,
                `Order #${shortId} Accepted — Preparing to Ship`,
                `Good news! The seller has accepted your order #${shortId} and is preparing it for shipment.\n\nYou will receive another notification when it ships.`,
                payload
            );
        }
    }
});

// shipment.out_for_delivery → buyer "out for delivery today" notification (R9/S12)
bus.on('shipment.out_for_delivery', async (payload) => {
    if (!await isNotifAllowed('SHIPMENT_CREATED', payload.buyerId)) return; // reuse shipmentUpdates flag
    if (!payload.buyerId) return;
    const buyerEmail = `buyer-${payload.buyerId}@markee.local`;
    await sendNotification(
        'SHIPMENT_CREATED',
        buyerEmail,
        `Your Package Is Out for Delivery Today`,
        `Your package is out for delivery today! ${payload.trackingNumber ? `Tracking: ${payload.trackingNumber}${payload.carrier ? ` via ${payload.carrier}` : ''}.` : ''} Keep an eye out.`,
        payload
    );
});

// shipment.overdue → seller nudge: unshipped order has been stalled > 48h (C5/S15)
bus.on('shipment.overdue', async (payload) => {
    if (!payload.sellerId) return;
    const sellerEmail = `seller-${payload.sellerId}@markee.local`;
    await sendNotification(
        'STOCK_LOW',  // reuse seller operational flag
        sellerEmail,
        `Reminder: Unshipped Order Awaiting Action`,
        `Your shipment for order ${payload.orderId?.toString().slice(-8).toUpperCase() || payload.orderId} has been in 'created' state for over 48 hours. Buyers are waiting — please update the shipment status or contact the buyer. /dashboard`,
        payload
    );
});

// shipment.buyer_confirmed → buyer + seller confirmation notifications (C7/S17)
bus.on('shipment.buyer_confirmed', async (payload) => {
    const { orderId, sellerId, buyerId } = payload;
    const shortId = orderId?.toString().slice(-8).toUpperCase() || '';
    if (buyerId) {
        await sendNotification(
            'DELIVERED_BUYER',
            `buyer-${buyerId}@markee.local`,
            `Delivery Confirmed — Order #${shortId}`,
            `You have confirmed receipt of order #${shortId}. You can now leave a review. /orders/${orderId}`,
            payload
        );
    }
    if (sellerId) {
        await sendNotification(
            'DELIVERED_SELLER',
            `seller-${sellerId}@markee.local`,
            `Buyer Confirmed Receipt — Order #${shortId}`,
            `The buyer has confirmed receipt of order #${shortId}. Your payout has been released from escrow.`,
            payload
        );
    }
});

// order.ready_for_pickup → buyer "your order is ready to collect" (R13/S19)
bus.on('order.ready_for_pickup', async (payload) => {
    if (!payload.buyerId) return;
    const shortId = payload.orderId?.toString().slice(-8).toUpperCase() || '';
    await sendNotification(
        'SHIPMENT_CREATED',
        `buyer-${payload.buyerId}@markee.local`,
        `Your Order #${shortId} Is Ready for Pickup`,
        `Good news! The seller has marked your order #${shortId} as ready for collection. Head over to pick it up at your convenience.`,
        payload
    );
});

// order.picked_up → buyer + seller notifications (R13/S19)
bus.on('order.picked_up', async (payload) => {
    const { orderId, sellerId, buyerId } = payload;
    const shortId = orderId?.toString().slice(-8).toUpperCase() || '';
    if (buyerId) {
        await sendNotification(
            'DELIVERED_BUYER',
            `buyer-${buyerId}@markee.local`,
            `Pickup Confirmed — Order #${shortId}`,
            `Your pickup for order #${shortId} has been confirmed. Enjoy your purchase! You can now leave a review. /orders/${orderId}`,
            payload
        );
    }
    if (sellerId) {
        await sendNotification(
            'DELIVERED_SELLER',
            `seller-${sellerId}@markee.local`,
            `Pickup Confirmed — Order #${shortId}`,
            `Order #${shortId} has been picked up. Your payout has been released from escrow.`,
            payload
        );
    }
});

// order.self_fulfilled → buyer + seller notifications (R14/S19)
bus.on('order.self_fulfilled', async (payload) => {
    const { orderId, sellerId, buyerId } = payload;
    const shortId = orderId?.toString().slice(-8).toUpperCase() || '';
    if (buyerId) {
        await sendNotification(
            'DELIVERED_BUYER',
            `buyer-${buyerId}@markee.local`,
            `Order #${shortId} Fulfilled`,
            `The seller has marked your order #${shortId} as fulfilled. You can now leave a review. /orders/${orderId}`,
            payload
        );
    }
    if (sellerId) {
        await sendNotification(
            'DELIVERED_SELLER',
            `seller-${sellerId}@markee.local`,
            `Order #${shortId} Marked as Fulfilled`,
            `Order #${shortId} has been marked fulfilled. Your payout has been released from escrow.`,
            payload
        );
    }
});

bus.on('inventory.purchase_blocked', async (payload) => {
    const { sellerId, title, qtyWanted, available } = payload;
    if (!sellerId) return;
    const sellerEmail = `seller-${sellerId}@markee.local`;
    const revenueLost = qtyWanted * ((payload.price || 0) / 100);
    await sendNotification(
        'MISSED_SALE',
        sellerEmail,
        `Missed Sale — "${title || 'Your product'}" is Out of Stock`,
        `A buyer tried to purchase ${qtyWanted} unit${qtyWanted !== 1 ? 's' : ''} of "${title || 'your product'}" but it was out of stock (${available} available).\n\nEstimated missed revenue: $${revenueLost.toFixed(2)}\n\nRestock now to capture this demand: /inventory`,
        payload
    );
});

bus.on('user.registered', async (payload) => {
    const { email, displayName } = payload;
    if (!email) return;
    const name = displayName || email.split('@')[0];
    await sendNotification(
        'WELCOME',
        email,
        `Welcome to Markee, ${name}!`,
        `Hi ${name},\n\nWelcome to Markee — the marketplace where buyers become sellers.\n\nHere's what you can do:\n• Browse thousands of products from local sellers\n• Save items to your Watchlist and get price-drop alerts\n• Start your own store in under a minute — no listing fees\n\nGet started: /dashboard\n\nHappy shopping,\nThe Markee Team`,
        payload
    );
});

// ── Smart Catalog: Targeted Re-engagement ────────────────────────────────────
bus.on('catalog.price_dropped', async (payload) => {
    try {
        const url = `http://localhost:5013/users/watching/${payload.productId}`;
        let response;
        
        try {
            response = await fetch(url);
        } catch (fetchErr) {
            console.warn('[NOTIFY] Failed to fetch target audience. network error:', fetchErr.message);
            return; // Exit cleanly without crashing daemon
        }

        if (!response.ok) {
            console.warn('[NOTIFY] User service audience query rejected. HTTP:', response.status);
            return; // Exit cleanly
        }

        const userIds = await response.json();
        if (!Array.isArray(userIds) || userIds.length === 0) return;

        console.log(`[NOTIFY] Dispatching price-drop re-engagement to ${userIds.length} watchers.`);

        for (const uid of userIds) {
            const buyerEmail = `buyer-${uid}@markee.local`; // Simulated routing
            await sendNotification(
                'PRICE_DROP_ALERT',
                buyerEmail,
                `Price Drop Alert: ${payload.title || 'Saved Product'}`,
                `A product in your Watchlist just dropped in price to $${((payload.newPrice || 0) / 100).toFixed(2)}.\n\nLog in to take another look!`,
                payload
            );
        }
    } catch (err) {
        console.error('[NOTIFY] Intended Engagement pipeline error:', err.message);
    }
});

// ── Phase 2: Store-event notification listeners ───────────────────────────────

// Fetches all user IDs watching any product from a given store.
// Returns [] on any failure (fail-open pattern — we just skip dispatch).
async function getStoreWatchers(storeId) {
    try {
        const res = await fetch(`http://localhost:5013/users/watching-store/${storeId}`);
        if (!res.ok) return [];
        const userIds = await res.json();
        return Array.isArray(userIds) ? userIds : [];
    } catch {
        return [];
    }
}

bus.on('store.sale_started', async (payload) => {
    try {
        const { storeId, storeName, headline, discountPercent, endsAt } = payload;
        const userIds = await getStoreWatchers(storeId);
        if (userIds.length === 0) return;
        console.log(`[NOTIFY] store.sale_started — dispatching to ${userIds.length} store watchers`);
        const pct     = discountPercent ? `${discountPercent}% off` : 'discounts';
        const subject = `Sale Live at ${storeName || 'a store you follow'}!`;
        const body    = `${storeName || 'A store'} you've saved products from just launched a sale: ${headline || pct}.\n\nShop now before it ends: /store/${storeId}`;
        for (const uid of userIds) {
            if (!await isNotifAllowed('SALE_STARTED', uid)) continue;
            await sendNotification(
                'SALE_STARTED',
                `buyer-${uid}@markee.local`,
                subject,
                body,
                payload,
                { userId: uid, link: `/store/${storeId}`, icon: 'fa-tag', priority: 'high' }
            );
        }
    } catch (err) { console.error('[NOTIFY] store.sale_started handler error:', err.message); }
});

bus.on('store.sale_ending_soon', async (payload) => {
    try {
        const { storeId, storeName, discountPercent, endsAt } = payload;
        const userIds = await getStoreWatchers(storeId);
        if (userIds.length === 0) return;
        console.log(`[NOTIFY] store.sale_ending_soon — dispatching to ${userIds.length} store watchers`);
        const pct     = discountPercent ? `${discountPercent}% off` : 'the sale';
        const subject = `Last Chance — Sale Ending Soon at ${storeName || 'a store you follow'}`;
        const body    = `The ${pct} sale at ${storeName || 'a store you follow'} ends soon. Don't miss out!\n\nShop now: /store/${storeId}`;
        for (const uid of userIds) {
            if (!await isNotifAllowed('SALE_ENDING_SOON', uid)) continue;
            await sendNotification(
                'SALE_ENDING_SOON',
                `buyer-${uid}@markee.local`,
                subject,
                body,
                payload,
                { userId: uid, link: `/store/${storeId}`, icon: 'fa-clock', priority: 'high' }
            );
        }
    } catch (err) { console.error('[NOTIFY] store.sale_ending_soon handler error:', err.message); }
});

bus.on('store.discount_activated', async (payload) => {
    try {
        const { storeId, storeName, discountPercent } = payload;
        const userIds = await getStoreWatchers(storeId);
        if (userIds.length === 0) return;
        console.log(`[NOTIFY] store.discount_activated — dispatching to ${userIds.length} store watchers`);
        const pct     = discountPercent ? `${discountPercent}%` : 'a store-wide';
        const subject = `${pct} Discount Active at ${storeName || 'a store you follow'}`;
        const body    = `${storeName || 'A store'} you've saved products from just activated a ${pct} store-wide discount. All their products are now cheaper!\n\nShop now: /store/${storeId}`;
        for (const uid of userIds) {
            if (!await isNotifAllowed('DISCOUNT_ACTIVATED', uid)) continue;
            await sendNotification(
                'DISCOUNT_ACTIVATED',
                `buyer-${uid}@markee.local`,
                subject,
                body,
                payload,
                { userId: uid, link: `/store/${storeId}`, icon: 'fa-percent', priority: 'medium' }
            );
        }
    } catch (err) { console.error('[NOTIFY] store.discount_activated handler error:', err.message); }
});

bus.on('store.reopened', async (payload) => {
    try {
        const { storeId, storeName } = payload;
        const userIds = await getStoreWatchers(storeId);
        if (userIds.length === 0) return;
        console.log(`[NOTIFY] store.reopened — dispatching to ${userIds.length} store watchers`);
        const subject = `${storeName || 'A store you follow'} is Open Again`;
        const body    = `${storeName || 'A store'} you've saved products from has reopened. Browse their latest listings.\n\nVisit: /store/${storeId}`;
        for (const uid of userIds) {
            if (!await isNotifAllowed('STORE_REOPENED', uid)) continue;
            await sendNotification(
                'STORE_REOPENED',
                `buyer-${uid}@markee.local`,
                subject,
                body,
                payload,
                { userId: uid, link: `/store/${storeId}`, icon: 'fa-store', priority: 'low' }
            );
        }
    } catch (err) { console.error('[NOTIFY] store.reopened handler error:', err.message); }
});

// A.9 — Seller: new review on your product
bus.on('review.submitted', async (payload) => {
    try {
        if (!payload.sellerId) return;
        if (!await isNotifAllowed('REVIEW_SUBMITTED_SELLER', payload.sellerId)) return;
        await sendNotification(
            'REVIEW_SUBMITTED_SELLER',
            `seller-${payload.sellerId}@markee.local`,
            `New ${payload.rating}★ Review on Your Product`,
            `A buyer just left a ${payload.rating}-star review. Log in to read it and reply.\n\nView: /product/${payload.productId}#reviews`,
            payload,
            { userId: payload.sellerId, link: `/product/${payload.productId}#reviews`, icon: 'fa-star', priority: 'medium' }
        );
    } catch (err) { console.error('[NOTIFY] review.submitted handler error:', err.message); }
});

// A.9 — Buyer: seller replied to your review
bus.on('seller.replied', async (payload) => {
    try {
        if (!payload.buyerId) return;
        if (!await isNotifAllowed('SELLER_REPLIED_BUYER', payload.buyerId)) return;
        await sendNotification(
            'SELLER_REPLIED_BUYER',
            `buyer-${payload.buyerId}@markee.local`,
            'The seller replied to your review',
            `The seller has responded to your review. Check the conversation.\n\nView: /product/${payload.productId}#reviews`,
            payload,
            { userId: payload.buyerId, link: `/product/${payload.productId}#reviews`, icon: 'fa-comment', priority: 'low' }
        );
    } catch (err) { console.error('[NOTIFY] seller.replied handler error:', err.message); }
});

// A.9 — Buyer: 48h post-delivery review nudge
bus.on('review.nudge', async (payload) => {
    try {
        if (!payload.buyerId) return;
        if (!await isNotifAllowed('REVIEW_NUDGE', payload.buyerId)) return;
        const titles = (payload.items || []).map(i => i.title).filter(Boolean).slice(0, 2).join(', ');
        await sendNotification(
            'REVIEW_NUDGE',
            `buyer-${payload.buyerId}@markee.local`,
            'How was your order? Leave a review!',
            `Your order has been delivered. Share your experience with ${titles || 'your purchase'} — your review helps other buyers.\n\nLeave a review: /orders/${payload.orderId}`,
            payload,
            { userId: payload.buyerId, link: `/orders/${payload.orderId}`, icon: 'fa-star', priority: 'low' }
        );
    } catch (err) { console.error('[NOTIFY] review.nudge handler error:', err.message); }
});

// Messaging — in-app bell notification when recipient is offline (C8 / S21a)
bus.on('message.unread', async (payload) => {
    try {
        const { recipientId, senderId, senderName, threadId, preview } = payload;
        if (!recipientId) return;
        // In-app only — no email for every message
        const doc = {
            type:     'MESSAGE_UNREAD',
            userId:   recipientId,
            channel:  'in_app',
            icon:     'fa-comments',
            priority: 'medium',
            link:     `/messages?thread=${threadId}`,
            subject:  `New message from ${senderName || 'someone'}`,
            body:     preview || 'You have a new message.',
            recipient: `user-${recipientId}@markee.local`,
            eventData: payload
        };
        await Notification.create(doc);
        console.log(`[NOTIFY] In-app message notification created for user ${recipientId}`);
    } catch (err) { console.error('[NOTIFY] message.unread handler error:', err.message); }
});

// ── Payment event notifications ───────────────────────────────────────────────

// S5 — payment.collected → buyer + seller: COD payment confirmed
bus.on('payment.collected', async (payload) => {
    const { orderId, buyerId, sellerId } = payload;
    const shortId = orderId?.toString().slice(-8).toUpperCase() || '';
    if (buyerId) {
        await sendNotification(
            'PAYMENT_CAPTURED',
            `buyer-${buyerId}@markee.local`,
            `Payment Collected — Order #${shortId}`,
            `The seller has confirmed payment collection for order #${shortId}. Your order is now complete. /orders/${orderId}`,
            payload,
            { userId: buyerId, link: `/orders/${orderId}`, icon: 'fa-check-circle', priority: 'medium' }
        );
    }
    if (sellerId) {
        await sendNotification(
            'PAYMENT_CAPTURED',
            `seller-${sellerId}@markee.local`,
            `COD Payment Marked Collected — Order #${shortId}`,
            `You have confirmed COD payment collection for order #${shortId}. The order is now complete.`,
            payload,
            { userId: sellerId, link: `/orders/${orderId}`, icon: 'fa-coins', priority: 'medium' }
        );
    }
});

// S8 — payment.auto_released → seller: payment released + buyer: dispute window closed
bus.on('payment.auto_released', async (payload) => {
    const { orderId, buyerId, sellerIds, amountCents } = payload;
    const shortId = orderId?.toString().slice(-8).toUpperCase() || '';
    const amount  = `$${((amountCents || 0) / 100).toFixed(2)}`;
    if (buyerId) {
        await sendNotification(
            'DELIVERED_BUYER',
            `buyer-${buyerId}@markee.local`,
            `Dispute Window Closed — Order #${shortId}`,
            `The dispute window for order #${shortId} has closed and payment has been released to the seller. If you have concerns, please contact support.`,
            payload,
            { userId: buyerId, link: `/orders/${orderId}`, icon: 'fa-clock', priority: 'low' }
        );
    }
    for (const sellerId of (sellerIds || [])) {
        await sendNotification(
            'DELIVERED_SELLER',
            `seller-${sellerId}@markee.local`,
            `Payment Released — Order #${shortId}`,
            `The 48-hour dispute window has passed. ${amount} has been released to your account for order #${shortId}.`,
            payload,
            { userId: sellerId, link: `/orders/${orderId}`, icon: 'fa-money-bill-wave', priority: 'medium' }
        );
    }
});

// S9 — payment.disputed → buyer: dispute received + seller: dispute filed against order
bus.on('payment.disputed', async (payload) => {
    const { orderId, buyerId, amountCents } = payload;
    const shortId = orderId?.toString().slice(-8).toUpperCase() || '';
    if (buyerId) {
        await sendNotification(
            'ORDER_ACCEPTED',
            `buyer-${buyerId}@markee.local`,
            `Dispute Filed — Order #${shortId}`,
            `Your dispute for order #${shortId} has been received. An admin will review and respond. Payment is currently on hold.`,
            payload,
            { userId: buyerId, link: `/orders/${orderId}`, icon: 'fa-exclamation-circle', priority: 'high' }
        );
    }
    // Notify all sellers on the escrow — use seller-payouts lookup via best-effort
    try {
        const escRes = await fetch(`http://localhost:5004/escrow/${orderId}`).catch(() => null);
        if (escRes?.ok) {
            const esc = await escRes.json();
            for (const payout of (esc.sellerPayouts || [])) {
                const sid = payout.sellerId?.toString();
                if (!sid) continue;
                await sendNotification(
                    'STOCK_LOW',
                    `seller-${sid}@markee.local`,
                    `Payment Dispute Filed — Order #${shortId}`,
                    `A buyer has filed a payment dispute for order #${shortId}. Payment is on hold pending admin review. We'll notify you of the resolution.`,
                    payload,
                    { userId: sid, link: `/orders/${orderId}`, icon: 'fa-exclamation-triangle', priority: 'high' }
                );
            }
        }
    } catch {}
});

// S10 — payment.refunded → buyer: refund processing
bus.on('payment.refunded', async (payload) => {
    const { orderId, buyerId, amountCents, reason } = payload;
    const shortId = orderId?.toString().slice(-8).toUpperCase() || '';
    const amount  = `$${((amountCents || 0) / 100).toFixed(2)}`;
    if (buyerId) {
        await sendNotification(
            'ORDER_CANCELLED_BUYER',
            `buyer-${buyerId}@markee.local`,
            `Refund Processing — Order #${shortId}`,
            `A refund of ${amount} is being processed for order #${shortId}.\n\nReason: ${reason || 'Admin approved refund'}\n\nRefunds typically appear within 3–5 business days.`,
            payload,
            { userId: buyerId, link: `/orders/${orderId}`, icon: 'fa-undo', priority: 'high' }
        );
    }
});

// S11 — payment.partial_refunded → buyer: partial refund issued
bus.on('payment.partial_refunded', async (payload) => {
    const { orderId, buyerId, refundAmountCents, reason } = payload;
    const shortId = orderId?.toString().slice(-8).toUpperCase() || '';
    const amount  = `$${((refundAmountCents || 0) / 100).toFixed(2)}`;
    if (buyerId) {
        await sendNotification(
            'ORDER_CANCELLED_BUYER',
            `buyer-${buyerId}@markee.local`,
            `Partial Refund Issued — Order #${shortId}`,
            `A partial refund of ${amount} has been issued for order #${shortId}.\n\nReason: ${reason || 'Admin approved partial refund'}`,
            payload,
            { userId: buyerId, link: `/orders/${orderId}`, icon: 'fa-undo', priority: 'medium' }
        );
    }
});

// S13 — payment.cod_rejected → buyer: COD not available
bus.on('payment.cod_rejected', async (payload) => {
    const { orderId, buyerId, reason } = payload;
    const shortId = orderId?.toString().slice(-8).toUpperCase() || '';
    if (buyerId) {
        await sendNotification(
            'ORDER_CANCELLED_BUYER',
            `buyer-${buyerId}@markee.local`,
            `COD Not Available — Order #${shortId} Cancelled`,
            `Unfortunately, Cash on Delivery is not available for your account at this seller.\n\nYour order #${shortId} has been cancelled. Please retry with an alternative payment method.`,
            payload,
            { userId: buyerId, link: `/orders/${orderId}`, icon: 'fa-ban', priority: 'high' }
        );
    }
});

// S14 — payment.released → seller: admin released payment
bus.on('payment.released', async (payload) => {
    const { orderId, sellerIds, amountCents, reason } = payload;
    const shortId = orderId?.toString().slice(-8).toUpperCase() || '';
    const amount  = `$${((amountCents || 0) / 100).toFixed(2)}`;
    for (const sellerId of (sellerIds || [])) {
        await sendNotification(
            'DELIVERED_SELLER',
            `seller-${sellerId}@markee.local`,
            `Payment Released by Admin — Order #${shortId}`,
            `An admin has released the payment of ${amount} for order #${shortId}.\n\nReason: ${reason || 'Admin review'}`,
            payload,
            { userId: sellerId, link: `/orders/${orderId}`, icon: 'fa-unlock', priority: 'high' }
        );
    }
});

// COD expiry notification
bus.on('payment.cod_expired', async (payload) => {
    const { orderId, buyerId, sellerIds } = payload;
    const shortId = orderId?.toString().slice(-8).toUpperCase() || '';
    if (buyerId) {
        await sendNotification(
            'ORDER_CANCELLED_BUYER',
            `buyer-${buyerId}@markee.local`,
            `COD Order #${shortId} Expired`,
            `Your COD order #${shortId} was not completed within 7 days and has been cancelled. Please contact support if you have questions.`,
            payload
        );
    }
    for (const sellerId of (sellerIds || [])) {
        await sendNotification(
            'STOCK_LOW',
            `seller-${sellerId}@markee.local`,
            `COD Order #${shortId} Expired`,
            `COD order #${shortId} was not marked as collected within 7 days and has been automatically cancelled.`,
            payload
        );
    }
});

// A.9 — Admin: review flagged 3x
bus.on('review.flagged', async (payload) => {
    try {
        if (payload.flagCount < 3) return;
        await sendNotification(
            'REVIEW_FLAGGED_ADMIN',
            'admin@markee.local',
            `Review flagged ${payload.flagCount}× — needs moderation`,
            `A review has been flagged ${payload.flagCount} times and returned to pending.\n\nReview ID: ${payload.reviewId}\n\nModerate: /admin`,
            payload,
            { icon: 'fa-flag', priority: 'high' }
        );
    } catch (err) { console.error('[NOTIFY] review.flagged handler error:', err.message); }
});

// S6 — Seller: product approved by admin — now live on Markee
bus.on('product.approved', async (payload) => {
    try {
        if (!payload.sellerId) return;
        await sendNotification(
            'PRODUCT_APPROVED',
            `seller-${payload.sellerId}@markee.local`,
            `Your product is now live — ${payload.title}`,
            `Great news! Your product "${payload.title}" has been approved and is now live on Markee.\n\nView it: /product/${payload.productId}`,
            payload,
            { userId: payload.sellerId, link: `/product/${payload.productId}`, icon: 'fa-check-circle', priority: 'high' }
        );
    } catch (err) { console.error('[NOTIFY] product.approved handler error:', err.message); }
});

// S6 — Seller: product rejected by admin — reason included, resubmit path explained
bus.on('product.rejected', async (payload) => {
    try {
        if (!payload.sellerId) return;
        await sendNotification(
            'PRODUCT_REJECTED',
            `seller-${payload.sellerId}@markee.local`,
            `Product not approved — ${payload.title}`,
            `Your product "${payload.title}" was not approved.\n\nReason: ${payload.reason}\n\nYou can edit your listing and resubmit it for review. Go to your dashboard to make changes.`,
            payload,
            { userId: payload.sellerId, link: `/dashboard`, icon: 'fa-times-circle', priority: 'high' }
        );
    } catch (err) { console.error('[NOTIFY] product.rejected handler error:', err.message); }
});

// S6 / C-C5 — Seller: 3+ consecutive rejections — policy guidance nudge
bus.on('seller.repeated_rejections', async (payload) => {
    try {
        if (!payload.sellerId) return;
        await sendNotification(
            'SELLER_REPEATED_REJECTIONS',
            `seller-${payload.sellerId}@markee.local`,
            'Action needed: multiple products not approved',
            `${payload.count} of your product listings have not passed review. Please review Markee's listing policies before resubmitting to avoid further delays.\n\nVisit your dashboard to see feedback on each listing.`,
            payload,
            { userId: payload.sellerId, link: `/dashboard`, icon: 'fa-exclamation-triangle', priority: 'high' }
        );
    } catch (err) { console.error('[NOTIFY] seller.repeated_rejections handler error:', err.message); }
});

// S32/S12 — Seller: new question on their product — nudge to answer
bus.on('product.question_asked', async (payload) => {
    try {
        if (!payload.sellerId) return;
        await sendNotification(
            'PRODUCT_QUESTION_ASKED',
            `seller-${payload.sellerId}@markee.local`,
            'A buyer has a question about your product',
            `A buyer asked: "${payload.preview || 'a question'}" on one of your listings. Answering quickly builds buyer trust.\n\nView: /product/${payload.productId}#qa`,
            payload,
            { userId: payload.sellerId, link: `/product/${payload.productId}#qa`, icon: 'fa-question-circle', priority: 'medium' }
        );
    } catch (err) { console.error('[NOTIFY] product.question_asked handler error:', err.message); }
});

// S32/S12 — Seller: question unanswered after 48h
bus.on('product.question_unanswered', async (payload) => {
    try {
        if (!payload.sellerId) return;
        await sendNotification(
            'PRODUCT_QUESTION_UNANSWERED',
            `seller-${payload.sellerId}@markee.local`,
            'A buyer question has been waiting 48 hours',
            `A buyer asked: "${payload.preview || 'a question'}" and has not received a reply. Unanswered questions may reduce buyer confidence.\n\nView: /product/${payload.productId}#qa`,
            payload,
            { userId: payload.sellerId, link: `/product/${payload.productId}#qa`, icon: 'fa-clock', priority: 'medium' }
        );
    } catch (err) { console.error('[NOTIFY] product.question_unanswered handler error:', err.message); }
});

// S32/S15 — Buyers: product back in stock (fan-out per requestedBy userId)
bus.on('inventory.restocked', async (payload) => {
    try {
        for (const userId of (payload.requestedBy || [])) {
            await sendNotification(
                'INVENTORY_RESTOCKED',
                `buyer-${userId}@markee.local`,
                'An item on your wishlist is back in stock',
                `Good news — a product you requested a restock alert for is now available again.\n\nView: /product/${payload.productId}`,
                payload,
                { userId, link: `/product/${payload.productId}`, icon: 'fa-box', priority: 'high' }
            );
        }
    } catch (err) { console.error('[NOTIFY] inventory.restocked handler error:', err.message); }
});

// S32/S26 — Seller: store verified by admin
bus.on('store.verified', async (payload) => {
    try {
        if (!payload.sellerId) return;
        await sendNotification(
            'STORE_VERIFIED',
            `seller-${payload.sellerId}@markee.local`,
            'Congratulations — your store is now verified on Markee',
            `Your store "${payload.storeName || 'your store'}" has been verified by the Markee team. The verified badge will now appear on your storefront and product listings.`,
            payload,
            { userId: payload.sellerId, link: `/dashboard`, icon: 'fa-shield-alt', priority: 'high' }
        );
    } catch (err) { console.error('[NOTIFY] store.verified handler error:', err.message); }
});

// S32/S29 — Seller: vacation mode activated confirmation
bus.on('store.vacation_started', async (payload) => {
    try {
        const resume = payload.resumesAt ? ` Scheduled return: ${new Date(payload.resumesAt).toLocaleDateString()}.` : '';
        await sendNotification(
            'STORE_VACATION_STARTED',
            `seller-@markee.local`,
            'Vacation mode is now active',
            `Your store "${payload.storeName || 'your store'}" is now in vacation mode. New orders are blocked until you return.${resume}`,
            payload,
            { link: `/dashboard`, icon: 'fa-plane', priority: 'medium' }
        );
    } catch (err) { console.error('[NOTIFY] store.vacation_started handler error:', err.message); }
});

// S32/S22 — Seller: buyer modified their order
bus.on('order.modified', async (payload) => {
    try {
        for (const sellerId of (payload.sellerIds || [])) {
            await sendNotification(
                'ORDER_MODIFIED',
                `seller-${sellerId}@markee.local`,
                'A buyer modified their order',
                `A buyer has modified order ${payload.orderId}. Please review the updated order details before fulfilling.\n\nView: /orders/${payload.orderId}`,
                payload,
                { userId: sellerId, link: `/orders/${payload.orderId}`, icon: 'fa-edit', priority: 'high' }
            );
        }
    } catch (err) { console.error('[NOTIFY] order.modified handler error:', err.message); }
});

// Scrub PII from notification records on hard-delete — records are kept for audit, userId/recipient cleared
bus.on('user.deleted', async (payload) => {
    try {
        const uid = payload.userId;
        const result = await Notification.updateMany(
            { userId: new mongoose.Types.ObjectId(uid) },
            { $set: { userId: null, recipient: '__deleted__' } }
        );
        console.log(`[NOTIFY] Scrubbed PII from ${result.modifiedCount} notification record(s) for user ${uid}`);
    } catch (err) { console.error('[NOTIFY] user.deleted PII scrub error:', err.message); }
});

// ── CC-1: Payment + Order gap listeners ──────────────────────────────────────

// payment.split_resolved → buyer + seller: dispute resolved with split decision
bus.on('payment.split_resolved', async (payload) => {
    try {
        const { orderId, buyerPercent, amounts } = payload;
        const shortId = orderId?.toString().slice(-8).toUpperCase() || '';
        if (payload.buyerId) {
            await sendNotification(
                'ORDER_CANCELLED_BUYER',
                `buyer-${payload.buyerId}@markee.local`,
                `Dispute Resolved — Order #${shortId}`,
                `Your dispute for order #${shortId} has been resolved. You will receive ${buyerPercent || ''}% of the payment. Check your orders for details.`,
                payload,
                { userId: payload.buyerId, link: `/orders/${orderId}`, icon: 'fa-gavel', priority: 'high' }
            );
        }
        const sellerIds = Array.isArray(payload.sellerIds) ? payload.sellerIds : (payload.sellerId ? [payload.sellerId] : []);
        for (const sellerId of sellerIds) {
            const sellerAmount = amounts?.[sellerId] ? `$${((amounts[sellerId]) / 100).toFixed(2)}` : 'your share';
            await sendNotification(
                'DELIVERED_SELLER',
                `seller-${sellerId}@markee.local`,
                `Dispute Resolved — Order #${shortId}`,
                `The dispute for order #${shortId} has been settled. You will receive ${sellerAmount}. Check your orders for details.`,
                payload,
                { userId: sellerId, link: `/orders/${orderId}`, icon: 'fa-gavel', priority: 'high' }
            );
        }
    } catch (err) { console.error('[NOTIFY] payment.split_resolved handler error:', err.message); }
});

// payment.pending → seller: new COD order pending collection
bus.on('payment.pending', async (payload) => {
    try {
        const { orderId, buyerId, amountCents } = payload;
        const shortId = orderId?.toString().slice(-8).toUpperCase() || '';
        const amount  = `$${((amountCents || 0) / 100).toFixed(2)}`;
        const sellerIds = Array.isArray(payload.sellerIds) ? payload.sellerIds : (payload.sellerId ? [payload.sellerId] : []);
        for (const sellerId of sellerIds) {
            await sendNotification(
                'PAYMENT_CAPTURED',
                `seller-${sellerId}@markee.local`,
                `New COD Order — #${shortId}`,
                `You have a new Cash on Delivery order (#${shortId}) pending collection of ${amount} from the buyer.`,
                payload,
                { userId: sellerId, link: `/orders/${orderId}`, icon: 'fa-hand-holding-usd', priority: 'medium' }
            );
        }
    } catch (err) { console.error('[NOTIFY] payment.pending handler error:', err.message); }
});

// order.reservation_expired → buyer: payment window timed out, order cancelled
bus.on('order.reservation_expired', async (payload) => {
    try {
        const { orderId, buyerId } = payload;
        if (!buyerId) return;
        const shortId = orderId?.toString().slice(-8).toUpperCase() || '';
        await sendNotification(
            'ORDER_CANCELLED_BUYER',
            `buyer-${buyerId}@markee.local`,
            `Order #${shortId} Reservation Expired`,
            `Your order reservation (#${shortId}) has expired — payment was not completed in time and the order has been cancelled. You can place a new order at any time.`,
            payload,
            { userId: buyerId, link: `/orders`, icon: 'fa-clock', priority: 'medium' }
        );
    } catch (err) { console.error('[NOTIFY] order.reservation_expired handler error:', err.message); }
});

// ── CC-2: Seller/Store lifecycle listeners ────────────────────────────────────

// store.suspended → seller: store has been suspended
bus.on('store.suspended', async (payload) => {
    try {
        if (!payload.sellerId) return;
        await sendNotification(
            'STORE_VERIFIED',
            `seller-${payload.sellerId}@markee.local`,
            `Your Store Has Been Suspended`,
            `Your store "${payload.storeName || 'your store'}" has been suspended.${payload.reason ? ` Reason: ${payload.reason}` : ''} Contact support if you believe this is an error.`,
            payload,
            { userId: payload.sellerId, link: `/dashboard`, icon: 'fa-ban', priority: 'critical' }
        );
    } catch (err) { console.error('[NOTIFY] store.suspended handler error:', err.message); }
});

// store.restored → seller: store has been restored
bus.on('store.restored', async (payload) => {
    try {
        if (!payload.sellerId) return;
        await sendNotification(
            'STORE_VERIFIED',
            `seller-${payload.sellerId}@markee.local`,
            `Your Store Has Been Restored`,
            `Your store "${payload.storeName || 'your store'}" has been restored and is now active.`,
            payload,
            { userId: payload.sellerId, link: `/dashboard`, icon: 'fa-check-circle', priority: 'high' }
        );
    } catch (err) { console.error('[NOTIFY] store.restored handler error:', err.message); }
});

// store.unverified → seller: store verification revoked
bus.on('store.unverified', async (payload) => {
    try {
        if (!payload.sellerId) return;
        await sendNotification(
            'STORE_VERIFIED',
            `seller-${payload.sellerId}@markee.local`,
            `Store Verification Revoked`,
            `Your store "${payload.storeName || 'your store'}" has had its verification status revoked. Contact support for more information.`,
            payload,
            { userId: payload.sellerId, link: `/dashboard`, icon: 'fa-times-circle', priority: 'high' }
        );
    } catch (err) { console.error('[NOTIFY] store.unverified handler error:', err.message); }
});

// store.vacation_ended → seller: vacation mode ended, store is live
bus.on('store.vacation_ended', async (payload) => {
    try {
        if (!payload.sellerId) return;
        await sendNotification(
            'STORE_VACATION_STARTED',
            `seller-${payload.sellerId}@markee.local`,
            `Vacation Mode Ended`,
            `Your store "${payload.storeName || 'your store'}" has exited vacation mode and is now visible to buyers.`,
            payload,
            { userId: payload.sellerId, link: `/dashboard`, icon: 'fa-store', priority: 'medium' }
        );
    } catch (err) { console.error('[NOTIFY] store.vacation_ended handler error:', err.message); }
});

// seller.tier_updated → seller: tier promotion or demotion
bus.on('seller.tier_updated', async (payload) => {
    try {
        const sellerId = payload.sellerId;
        if (!sellerId) return;
        await sendNotification(
            'PAYMENT_CAPTURED',
            `seller-${sellerId}@markee.local`,
            `Your Seller Tier Has Changed`,
            `Your seller tier has been updated to ${payload.tier || 'a new tier'}. Log in to your dashboard to see your updated benefits and limits.`,
            payload,
            { userId: sellerId, link: `/dashboard`, icon: 'fa-trophy', priority: 'medium' }
        );
    } catch (err) { console.error('[NOTIFY] seller.tier_updated handler error:', err.message); }
});

// seller.deactivated → seller: account deactivated, products no longer visible
bus.on('seller.deactivated', async (payload) => {
    try {
        const sellerId = payload.sellerId;
        if (!sellerId) return;
        await sendNotification(
            'STORE_VERIFIED',
            `seller-${sellerId}@markee.local`,
            `Seller Account Deactivated`,
            `Your seller account has been deactivated. Your products are no longer visible to buyers. Contact support for assistance.`,
            payload,
            { userId: sellerId, link: `/dashboard`, icon: 'fa-user-slash', priority: 'critical' }
        );
    } catch (err) { console.error('[NOTIFY] seller.deactivated handler error:', err.message); }
});

// seller.reactivated → seller: account reactivated, products visible again
bus.on('seller.reactivated', async (payload) => {
    try {
        const sellerId = payload.sellerId;
        if (!sellerId) return;
        await sendNotification(
            'STORE_VERIFIED',
            `seller-${sellerId}@markee.local`,
            `Seller Account Reactivated`,
            `Your seller account has been reactivated. Your products are visible to buyers again.`,
            payload,
            { userId: sellerId, link: `/dashboard`, icon: 'fa-user-check', priority: 'high' }
        );
    } catch (err) { console.error('[NOTIFY] seller.reactivated handler error:', err.message); }
});

// ── CC-3: User lifecycle listeners ────────────────────────────────────────────

// user.pending_deletion → user: account scheduled for deletion in 24h
bus.on('user.pending_deletion', async (payload) => {
    try {
        const userId = payload.userId;
        if (!userId) return;
        await sendNotification(
            'ORDER_PLACED',
            `user-${userId}@markee.local`,
            `Account Deletion Scheduled`,
            `Your Markee account is scheduled for permanent deletion in 24 hours. If you did not request this, log in immediately to cancel.`,
            payload,
            { userId, link: `/profile`, icon: 'fa-user-clock', priority: 'critical' }
        );
    } catch (err) { console.error('[NOTIFY] user.pending_deletion handler error:', err.message); }
});

// user.deletion_cancelled → user: deletion cancelled, account safe
bus.on('user.deletion_cancelled', async (payload) => {
    try {
        const userId = payload.userId;
        if (!userId) return;
        await sendNotification(
            'ORDER_PLACED',
            `user-${userId}@markee.local`,
            `Account Deletion Cancelled`,
            `Your account deletion request has been cancelled. Your Markee account is safe.`,
            payload,
            { userId, link: `/profile`, icon: 'fa-user-shield', priority: 'high' }
        );
    } catch (err) { console.error('[NOTIFY] user.deletion_cancelled handler error:', err.message); }
});

// user.self_deleted → email only (user no longer exists for in-app)
bus.on('user.self_deleted', async (payload) => {
    try {
        if (!payload.email) return;
        await sendNotification(
            'ORDER_PLACED',
            payload.email,
            `Your Markee Account Has Been Deleted`,
            `Your Markee account has been permanently deleted as requested. If you change your mind, you can create a new account at any time.`,
            payload
            // no inApp — user is deleted
        );
    } catch (err) { console.error('[NOTIFY] user.self_deleted handler error:', err.message); }
});

// user.suspended → user: account suspended
bus.on('user.suspended', async (payload) => {
    try {
        const userId = payload.userId;
        if (!userId) return;
        await sendNotification(
            'ORDER_PLACED',
            `user-${userId}@markee.local`,
            `Account Suspended`,
            `Your Markee account has been suspended.${payload.reason ? ` Reason: ${payload.reason}` : ''} Contact support if you believe this is an error.`,
            payload,
            { userId, link: `/profile`, icon: 'fa-user-lock', priority: 'critical' }
        );
    } catch (err) { console.error('[NOTIFY] user.suspended handler error:', err.message); }
});

// user.banned → user: account banned
bus.on('user.banned', async (payload) => {
    try {
        const userId = payload.userId;
        if (!userId) return;
        await sendNotification(
            'ORDER_PLACED',
            `user-${userId}@markee.local`,
            `Account Banned`,
            `Your Markee account has been banned.${payload.reason ? ` Reason: ${payload.reason}` : ''} Contact support to appeal.`,
            payload,
            { userId, link: `/profile`, icon: 'fa-ban', priority: 'critical' }
        );
    } catch (err) { console.error('[NOTIFY] user.banned handler error:', err.message); }
});

// user.unbanned → user: account reinstated
bus.on('user.unbanned', async (payload) => {
    try {
        const userId = payload.userId;
        if (!userId) return;
        await sendNotification(
            'ORDER_PLACED',
            `user-${userId}@markee.local`,
            `Account Reinstated`,
            `Your Markee account has been reinstated. Welcome back — you can now log in and use Markee as normal.`,
            payload,
            { userId, link: `/`, icon: 'fa-user-check', priority: 'high' }
        );
    } catch (err) { console.error('[NOTIFY] user.unbanned handler error:', err.message); }
});

// ── Routes ───────────────────────────────────────────────────────────────────

app.get('/logs', async (req, res) => {
    try {
        const logs = await Notification.find().sort({ sentAt: -1 }).limit(100);
        res.json(logs);
    } catch (err) { errorResponse(res, 500, err.message); }
});

// Legacy route — kept for admin panel compatibility
app.get('/notifications/:userId', async (req, res) => {
    try {
        const recipientEmail = `buyer-${req.params.userId}@markee.local`;
        const notifications = await Notification.find({ recipient: recipientEmail }).sort({ sentAt: -1 }).limit(50);
        res.json(notifications);
    } catch (err) { errorResponse(res, 500, err.message); }
});

// ── In-app notification routes ────────────────────────────────────────────────

// GET /my — last 20 in-app notifications for the authenticated user
app.get('/my', async (req, res) => {
    if (!req.user?.sub) return errorResponse(res, 401, 'Unauthorized');
    try {
        const notifications = await Notification.find({
            userId: new mongoose.Types.ObjectId(req.user.sub),
            channel: { $in: ['in_app', 'both'] }
        }).sort({ sentAt: -1 }).limit(20);
        res.json(notifications);
    } catch (err) { errorResponse(res, 500, err.message); }
});

// GET /unread-count — { count: N } for bell badge
app.get('/unread-count', async (req, res) => {
    if (!req.user?.sub) return errorResponse(res, 401, 'Unauthorized');
    try {
        const count = await Notification.countDocuments({
            userId:  new mongoose.Types.ObjectId(req.user.sub),
            channel: { $in: ['in_app', 'both'] },
            read:    false
        });
        res.json({ count });
    } catch (err) { errorResponse(res, 500, err.message); }
});

// PATCH /read-all — mark all unread as read for this user
app.patch('/read-all', async (req, res) => {
    if (!req.user?.sub) return errorResponse(res, 401, 'Unauthorized');
    try {
        await Notification.updateMany(
            { userId: new mongoose.Types.ObjectId(req.user.sub), read: false },
            { $set: { read: true } }
        );
        res.json({ ok: true });
    } catch (err) { errorResponse(res, 500, err.message); }
});

// PATCH /:id/read — mark single notification as read
app.patch('/:id/read', async (req, res) => {
    if (!req.user?.sub) return errorResponse(res, 401, 'Unauthorized');
    try {
        await Notification.findOneAndUpdate(
            { _id: req.params.id, userId: req.user.sub },
            { $set: { read: true } }
        );
        res.json({ ok: true });
    } catch (err) { errorResponse(res, 500, err.message); }
});

// ── ADMIN ROUTES ──────────────────────────────────────────────────────────────

// Inline NotificationTemplate model
const NotificationTemplate = mongoose.model('NotificationTemplate', new mongoose.Schema({
    type:      { type: String, required: true, unique: true },
    subject:   String,
    body:      String,
    updatedAt: Date,
    updatedBy: String
}));

// GET /admin/logs — notification audit log, paginated
app.get('/admin/logs', async (req, res) => {
    if (req.user?.role !== 'admin') return errorResponse(res, 403, 'Admin only');
    try {
        const page   = Math.max(1, parseInt(req.query.page)  || 1);
        const limit  = Math.min(200, parseInt(req.query.limit) || 50);
        const skip   = (page - 1) * limit;
        const filter = {};
        if (req.query.userId) filter.userId  = req.query.userId;
        if (req.query.type)   filter.type    = req.query.type;
        if (req.query.status) filter.status  = req.query.status;
        const [total, logs] = await Promise.all([
            Notification.countDocuments(filter),
            Notification.find(filter).sort({ sentAt: -1 }).skip(skip).limit(limit)
        ]);
        res.json({ logs, total, page });
    } catch (err) { errorResponse(res, 500, err.message); }
});

// GET /admin/templates — list all notification templates
app.get('/admin/templates', async (req, res) => {
    if (req.user?.role !== 'admin') return errorResponse(res, 403, 'Admin only');
    try {
        const stored = await NotificationTemplate.find().sort({ type: 1 });
        if (stored.length > 0) return res.json({ templates: stored });
        // Fallback: static list of known template types
        const templates = [
            { type: 'ORDER_PLACED',          subject: 'Order Confirmed',              body: 'Your order has been placed.' },
            { type: 'ORDER_ACCEPTED',         subject: 'Order Accepted',               body: 'The seller has accepted your order.' },
            { type: 'ORDER_CANCELLED_BUYER',  subject: 'Order Cancelled',             body: 'Your order has been cancelled.' },
            { type: 'SHIPMENT_CREATED',       subject: 'Your Order Has Shipped',      body: 'Your order is on the way.' },
            { type: 'DELIVERED_BUYER',        subject: 'Order Delivered',             body: 'Your order has been delivered.' },
            { type: 'DELIVERED_SELLER',       subject: 'Payout Triggered',            body: 'Your payout has been released.' },
            { type: 'PAYMENT_CAPTURED',       subject: 'New Order Received',          body: 'You have a new paid order.' },
            { type: 'STOCK_LOW',              subject: 'Low Stock Alert',             body: 'Your product is running low on stock.' },
            { type: 'REVIEW_APPROVED',        subject: 'Review Published',            body: 'Your review is now live.' },
            { type: 'PRICE_DROP_ALERT',       subject: 'Price Drop Alert',            body: 'A saved product dropped in price.' },
            { type: 'MESSAGE_UNREAD',         subject: 'New Message',                 body: 'You have a new message.' },
            { type: 'WELCOME',                subject: 'Welcome to Markee',           body: 'Welcome! Start browsing or open your store.' }
        ];
        res.json({ templates });
    } catch (err) { errorResponse(res, 500, err.message); }
});

// PATCH /admin/templates/:type — upsert a notification template
app.patch('/admin/templates/:type', async (req, res) => {
    if (req.user?.role !== 'admin') return errorResponse(res, 403, 'Admin only');
    const { subject, body } = req.body;
    try {
        const template = await NotificationTemplate.findOneAndUpdate(
            { type: req.params.type },
            { $set: { subject, body, updatedAt: new Date(), updatedBy: req.user.sub } },
            { upsert: true, new: true }
        );
        res.json(template);
    } catch (err) { errorResponse(res, 500, err.message); }
});

// POST /admin/templates/:type/preview — preview template with sample data substitution
app.post('/admin/templates/:type/preview', async (req, res) => {
    if (req.user?.role !== 'admin') return errorResponse(res, 403, 'Admin only');
    const { sampleData = {} } = req.body;
    try {
        const tmpl = await NotificationTemplate.findOne({ type: req.params.type });
        let subject = tmpl?.subject || `[${req.params.type}] subject`;
        let body    = tmpl?.body    || `[${req.params.type}] body`;
        // Basic {{variable}} substitution
        for (const [key, val] of Object.entries(sampleData)) {
            const re = new RegExp(`\\{\\{\\s*${key}\\s*\\}\\}`, 'g');
            subject  = subject.replace(re, val);
            body     = body.replace(re, val);
        }
        res.json({ type: req.params.type, subject, body });
    } catch (err) { errorResponse(res, 500, err.message); }
});

// DELETE /admin/notifications/:id — hard delete a notification
app.delete('/admin/notifications/:id', async (req, res) => {
    if (req.user?.role !== 'admin') return errorResponse(res, 403, 'Admin only');
    try {
        const result = await Notification.deleteOne({ _id: req.params.id });
        if (result.deletedCount === 0) return errorResponse(res, 404, 'Notification not found');
        res.json({ success: true });
    } catch (err) { errorResponse(res, 500, err.message); }
});

// POST /admin/notifications/resend/:id — resend a failed notification
app.post('/admin/notifications/resend/:id', async (req, res) => {
    if (req.user?.role !== 'admin') return errorResponse(res, 403, 'Admin only');
    try {
        const notif = await Notification.findById(req.params.id);
        if (!notif) return errorResponse(res, 404, 'Notification not found');
        notif.status = 'pending';
        await notif.save();
        res.json({ success: true, notificationId: notif._id });
    } catch (err) { errorResponse(res, 500, err.message); }
});

// GET /admin/notifications/stats — volume stats by type for last 7 days
app.get('/admin/notifications/stats', async (req, res) => {
    if (req.user?.role !== 'admin') return errorResponse(res, 403, 'Admin only');
    try {
        const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
        const counts = await Notification.aggregate([
            { $match: { sentAt: { $gte: since } } },
            { $group: { _id: '$type', count: { $sum: 1 } } }
        ]);
        const byType = {};
        for (const { _id, count } of counts) byType[_id] = count;
        res.json({ byType, since });
    } catch (err) { errorResponse(res, 500, err.message); }
});

app.get('/health', (req, res) => {
    res.json({ service: 'notification-service', status: 'ok', dbState: db.readyState === 1 ? 'connected' : 'disconnected' });
});

app.listen(process.env.PORT || 5010, () => console.log(`Notification Service on port ${process.env.PORT || 5010}`));
