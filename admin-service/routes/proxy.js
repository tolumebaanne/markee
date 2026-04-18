/**
 * Admin Proxy Routes — /admin/proxy/*
 *
 * Authenticated admin calls proxied to downstream services.
 * Each route enforces the correct admin permission before forwarding.
 *
 * Service Communication Principle (m0t.OPERATOR.1.3):
 * Admin Service orchestrates via REST calls — never writes directly
 * to another service's database.
 */
const express = require('express');
const router  = express.Router();

const requireAdminAuth        = require('../middleware/requireAdminAuth');
const requirePermission       = require('../middleware/requirePermission');
const requireReviewPermission = require('../middleware/requireReviewPermission');
const sessionActivity         = require('../middleware/sessionActivity');
const auditLog                = require('../middleware/auditLog');
const errorResponse           = require('../../shared/utils/errorResponse');

router.use(requireAdminAuth, sessionActivity);

// ── Service fetch helper ──────────────────────────────────────────────────────
async function callService(method, url, body = null, adminEmail = '') {
  const opts = {
    method: method.toUpperCase(),
    headers: {
      'Content-Type': 'application/json',
      'x-admin-email': adminEmail
    }
  };
  if (body && method !== 'GET') opts.body = JSON.stringify(body);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20000);
  try {
    const res = await fetch(url, { ...opts, signal: controller.signal });
    clearTimeout(timer);
    const data = await res.json().catch(() => ({}));
    return { ok: res.ok, status: res.status, data };
  } catch (err) {
    clearTimeout(timer);
    return { ok: false, status: 503, data: { error: err.message || 'Service unreachable' } };
  }
}

// ── Catalog ───────────────────────────────────────────────────────────────────
const catalogUrl = () => process.env.CATALOG_SERVICE_URL || 'http://localhost:5002';

router.get('/catalog/pending-review', requirePermission('catalog', 'approve'), async (req, res) => {
  const r = await callService('GET', `${catalogUrl()}/products/pending-review`, null, req.admin.email);
  res.status(r.status).json(r.data);
});

router.post('/catalog/products/:id/approve',
  requirePermission('catalog', 'approve'),
  auditLog('catalog.approve', 'Product'),
  async (req, res) => {
    const r = await callService('POST', `${catalogUrl()}/products/${req.params.id}/approve`, req.body, req.admin.email);
    res.status(r.status).json(r.data);
  }
);

router.post('/catalog/products/:id/reject',
  requirePermission('catalog', 'reject'),
  auditLog('catalog.reject', 'Product'),
  async (req, res) => {
    const r = await callService('POST', `${catalogUrl()}/products/${req.params.id}/reject`, req.body, req.admin.email);
    res.status(r.status).json(r.data);
  }
);

router.post('/catalog/products/:id/feature',
  requirePermission('catalog', 'feature'),
  auditLog('catalog.feature', 'Product'),
  async (req, res) => {
    const r = await callService('POST', `${catalogUrl()}/products/${req.params.id}/feature`, req.body, req.admin.email);
    res.status(r.status).json(r.data);
  }
);

// ── Catalog Admin Coupons ─────────────────────────────────────────────────────

router.get('/catalog/admin/coupons', requirePermission('catalog', 'approve'), async (req, res) => {
  const qs = new URLSearchParams(req.query).toString();
  const r = await callService('GET', `${catalogUrl()}/admin/coupons?${qs}`, null, req.admin.email);
  res.status(r.status).json(r.data);
});

router.post('/catalog/admin/coupons',
  requirePermission('catalog', 'approve'),
  auditLog('catalog.coupon.create', 'Coupon'),
  async (req, res) => {
    const r = await callService('POST', `${catalogUrl()}/admin/coupons`, req.body, req.admin.email);
    res.status(r.status).json(r.data);
  }
);

router.patch('/catalog/admin/coupons/:code/deactivate',
  requirePermission('catalog', 'approve'),
  auditLog('catalog.coupon.deactivate', 'Coupon'),
  async (req, res) => {
    const r = await callService('PATCH', `${catalogUrl()}/admin/coupons/${encodeURIComponent(req.params.code)}/deactivate`, null, req.admin.email);
    res.status(r.status).json(r.data);
  }
);

router.delete('/catalog/admin/coupons/:code',
  requirePermission('catalog', 'approve'),
  auditLog('catalog.coupon.delete', 'Coupon'),
  async (req, res) => {
    const r = await callService('DELETE', `${catalogUrl()}/admin/coupons/${encodeURIComponent(req.params.code)}`, null, req.admin.email);
    res.status(r.status).json(r.data);
  }
);

router.get('/catalog/admin/coupons/:code/usages', requirePermission('catalog', 'approve'), async (req, res) => {
  const qs = new URLSearchParams(req.query).toString();
  const r = await callService('GET', `${catalogUrl()}/admin/coupons/${encodeURIComponent(req.params.code)}/usages?${qs}`, null, req.admin.email);
  res.status(r.status).json(r.data);
});

// ── Listing Review (reviewer-facing catalog proxy routes) ─────────────────────

router.get('/catalog/products/review/unassigned',
  requireReviewPermission('canReview'),
  async (req, res) => {
    const r = await callService('GET', `${catalogUrl()}/products/review/unassigned`, null, req.admin.email);
    res.status(r.status).json(r.data);
  }
);

router.get('/catalog/products/review/assigned/:adminId',
  requireReviewPermission('canReview'),
  async (req, res) => {
    const r = await callService('GET', `${catalogUrl()}/products/review/assigned/${req.params.adminId}`, null, req.admin.email);
    res.status(r.status).json(r.data);
  }
);

router.get('/catalog/products/review/history',
  requireReviewPermission('canReview'),
  async (req, res) => {
    const qs = new URLSearchParams(req.query).toString();
    const r  = await callService('GET', `${catalogUrl()}/products/review/history?${qs}`, null, req.admin.email);
    res.status(r.status).json(r.data);
  }
);

router.post('/catalog/products/:id/disapprove',
  requireReviewPermission('canReview'),
  auditLog('listingReview.disapprove', 'Product'),
  async (req, res) => {
    const r = await callService('POST', `${catalogUrl()}/products/${req.params.id}/disapprove`, req.body, req.admin.email);
    res.status(r.status).json(r.data);
  }
);

router.post('/catalog/products/review/assign',
  requireReviewPermission('canAssign'),
  auditLog('listingReview.assign', 'Product'),
  async (req, res) => {
    const r = await callService('POST', `${catalogUrl()}/products/review/assign`, req.body, req.admin.email);
    res.status(r.status).json(r.data);
  }
);

router.post('/catalog/products/review/reassign',
  requireReviewPermission('canAssign'),
  auditLog('listingReview.reassign', 'Product'),
  async (req, res) => {
    const r = await callService('POST', `${catalogUrl()}/products/review/reassign`, req.body, req.admin.email);
    res.status(r.status).json(r.data);
  }
);

router.post('/catalog/products/review/pullback',
  requireReviewPermission('canAssign'),
  auditLog('listingReview.pullback', 'Product'),
  async (req, res) => {
    const r = await callService('POST', `${catalogUrl()}/products/review/pullback`, req.body, req.admin.email);
    res.status(r.status).json(r.data);
  }
);

// GET /catalog/products/:id — reviewer detail view (after all specific routes so :id doesn't shadow them)
router.get('/catalog/products/:id',
  requireReviewPermission('canReview'),
  async (req, res) => {
    const r = await callService('GET', `${catalogUrl()}/products/${req.params.id}`, null, req.admin.email);
    res.status(r.status).json(r.data);
  }
);

// ── Orders ─────────────────────────────────────────────────────────────────────
const orderUrl = () => process.env.ORDER_SERVICE_URL || 'http://localhost:5003';

router.get('/orders', requirePermission('orders', 'read'), async (req, res) => {
  const qs = new URLSearchParams(req.query).toString();
  const r  = await callService('GET', `${orderUrl()}/admin/orders?${qs}`, null, req.admin.email);
  res.status(r.status).json(r.data);
});

router.get('/orders/:id', requirePermission('orders', 'read'), async (req, res) => {
  const r = await callService('GET', `${orderUrl()}/admin/orders/${req.params.id}`, null, req.admin.email);
  res.status(r.status).json(r.data);
});

router.post('/orders/:id/force-status',
  requirePermission('orders', 'forceStatus'),
  auditLog('order.forceStatus', 'Order'),
  async (req, res) => {
    const r = await callService('POST', `${orderUrl()}/admin/orders/${req.params.id}/status`, req.body, req.admin.email);
    res.status(r.status).json(r.data);
  }
);

router.post('/orders/:id/cancel',
  requirePermission('orders', 'cancel'),
  auditLog('order.cancel', 'Order'),
  async (req, res) => {
    const r = await callService('POST', `${orderUrl()}/admin/orders/${req.params.id}/cancel`, req.body, req.admin.email);
    res.status(r.status).json(r.data);
  }
);

router.delete('/orders/:id',
  (req, res, next) => {
    if (!req.admin.isSuperuser) return errorResponse(res, 403, 'Superuser only');
    next();
  },
  auditLog('order.delete', 'Order'),
  async (req, res) => {
    const r = await callService('DELETE', `${orderUrl()}/admin/orders/${req.params.id}`, null, req.admin.email);
    res.status(r.status).json(r.data);
  }
);

// ── Payments ──────────────────────────────────────────────────────────────────
const paymentUrl = () => process.env.PAYMENT_SERVICE_URL || 'http://localhost:5004';

router.get('/payments/admin', requirePermission('payments', 'read'), async (req, res) => {
  const qs = new URLSearchParams(req.query).toString();
  const r  = await callService('GET', `${paymentUrl()}/admin/escrows?${qs}`, null, req.admin.email);
  res.status(r.status).json(r.data);
});

router.get('/payments/disputes', requirePermission('payments', 'read'), async (req, res) => {
  const r = await callService('GET', `${paymentUrl()}/admin/disputes`, null, req.admin.email);
  res.status(r.status).json(r.data);
});

router.get('/payments/summary', requirePermission('payments', 'read'), async (req, res) => {
  const r = await callService('GET', `${paymentUrl()}/admin/summary`, null, req.admin.email);
  res.status(r.status).json(r.data);
});

router.get('/payments/analytics', requirePermission('payments', 'read'), async (req, res) => {
  const r = await callService('GET', `${paymentUrl()}/analytics`, null, req.admin.email);
  res.status(r.status).json(r.data);
});

router.patch('/payments/:orderId/freeze',
  requirePermission('payments', 'freeze'),
  auditLog('payment.freeze', 'Payment'),
  async (req, res) => {
    const r = await callService('PATCH', `${paymentUrl()}/admin/escrows/${req.params.orderId}/freeze`, req.body, req.admin.email);
    res.status(r.status).json(r.data);
  }
);

router.patch('/payments/:orderId/unfreeze',
  requirePermission('payments', 'freeze'),
  auditLog('payment.unfreeze', 'Payment'),
  async (req, res) => {
    const r = await callService('PATCH', `${paymentUrl()}/admin/escrows/${req.params.orderId}/unfreeze`, req.body, req.admin.email);
    res.status(r.status).json(r.data);
  }
);

router.post('/payments/:orderId/force-release',
  requirePermission('payments', 'release'),
  auditLog('payment.forceRelease', 'Payment'),
  async (req, res) => {
    const r = await callService('POST', `${paymentUrl()}/admin/escrows/${req.params.orderId}/force-release`, req.body, req.admin.email);
    res.status(r.status).json(r.data);
  }
);

router.post('/payments/:id/refund',
  requirePermission('payments', 'refund'),
  auditLog('payment.refund', 'Payment'),
  async (req, res) => {
    const r = await callService('POST', `${paymentUrl()}/refund/${req.params.id}`, req.body, req.admin.email);
    res.status(r.status).json(r.data);
  }
);

router.post('/payments/:id/release',
  requirePermission('payments', 'release'),
  auditLog('payment.release', 'Payment'),
  async (req, res) => {
    const r = await callService('PATCH', `${paymentUrl()}/release/${req.params.id}`, req.body, req.admin.email);
    res.status(r.status).json(r.data);
  }
);

// ── Sellers ────────────────────────────────────────────────────────────────────
const sellerUrl = () => process.env.SELLER_SERVICE_URL || 'http://localhost:5005';

router.get('/sellers', requirePermission('sellers', 'read'), async (req, res) => {
  const qs = new URLSearchParams(req.query).toString();
  const r  = await callService('GET', `${sellerUrl()}/admin/stores?${qs}`, null, req.admin.email);
  res.status(r.status).json(r.data);
});

router.post('/sellers/:storeId/verify',
  requirePermission('sellers', 'verify'),
  auditLog('seller.verify', 'Store'),
  async (req, res) => {
    const r = await callService('POST', `${sellerUrl()}/admin/${req.params.storeId}/verify`, {}, req.admin.email);
    res.status(r.status).json(r.data);
  }
);

router.post('/sellers/:storeId/unverify',
  requirePermission('sellers', 'verify'),
  auditLog('seller.unverify', 'Store'),
  async (req, res) => {
    const r = await callService('POST', `${sellerUrl()}/admin/${req.params.storeId}/unverify`, {}, req.admin.email);
    res.status(r.status).json(r.data);
  }
);

router.post('/sellers/:storeId/suspend',
  requirePermission('sellers', 'suspend'),
  auditLog('seller.suspend', 'Store'),
  async (req, res) => {
    const r = await callService('POST', `${sellerUrl()}/admin/${req.params.storeId}/suspend`, req.body, req.admin.email);
    res.status(r.status).json(r.data);
  }
);

router.post('/sellers/:storeId/restore',
  requirePermission('sellers', 'suspend'),
  auditLog('seller.restore', 'Store'),
  async (req, res) => {
    const r = await callService('POST', `${sellerUrl()}/admin/${req.params.storeId}/restore`, req.body, req.admin.email);
    res.status(r.status).json(r.data);
  }
);

// ── Reviews ────────────────────────────────────────────────────────────────────
const reviewUrl = () => process.env.REVIEW_SERVICE_URL || 'http://localhost:5008';

// Admin moderation queue (pending + flagged)
router.get('/reviews/pending',
  requirePermission('reviews', 'read'),
  async (req, res) => {
    const r = await callService('GET', `${reviewUrl()}/pending`, null, req.admin.email);
    res.status(r.status).json(r.data);
  }
);

// Approve or flag a review
router.patch('/reviews/:id/moderate',
  requirePermission('reviews', 'moderate'),
  auditLog('review.moderate', 'Review'),
  async (req, res) => {
    const r = await callService('PATCH', `${reviewUrl()}/${req.params.id}/moderate`, req.body, req.admin.email);
    res.status(r.status).json(r.data);
  }
);

// Segment 6: BuyerReview admin moderation — must be registered BEFORE the generic /:id DELETE
// to prevent Express matching buyer/:id with :id="buyer"
router.get('/reviews/buyer-all',
  requirePermission('reviews', 'read'),
  async (req, res) => {
    const r = await callService('GET', `${reviewUrl()}/admin/buyer-review/all`, null, req.admin.email);
    res.status(r.status).json(r.data);
  }
);

router.delete('/reviews/buyer/:id',
  requirePermission('reviews', 'delete'),
  auditLog('buyerReview.delete', 'BuyerReview'),
  async (req, res) => {
    const r = await callService('DELETE', `${reviewUrl()}/admin/buyer-review/${req.params.id}`, { reason: req.body?.reason }, req.admin.email);
    res.status(r.status).json(r.data);
  }
);

router.delete('/reviews/:id',
  requirePermission('reviews', 'delete'),
  auditLog('review.delete', 'Review'),
  async (req, res) => {
    const r = await callService('DELETE', `${reviewUrl()}/admin/${req.params.id}`, { reason: req.body.reason }, req.admin.email);
    res.status(r.status).json(r.data);
  }
);

// Segment 6: Platform-wide review health stats (superuser only)
router.get('/reviews/stats/platform',
  (req, res, next) => {
    if (!req.admin.isSuperuser) return errorResponse(res, 403, 'Superuser only');
    next();
  },
  async (req, res) => {
    const r = await callService('GET', `${reviewUrl()}/stats/platform`, null, req.admin.email);
    res.status(r.status).json(r.data);
  }
);

// Segment 6: Seller store rating for admin seller cards
router.get('/reviews/seller/:storeId/stats',
  requirePermission('sellers', 'read'),
  async (req, res) => {
    const r = await callService('GET', `${reviewUrl()}/seller/${req.params.storeId}/stats`, null, req.admin.email);
    res.status(r.status).json(r.data);
  }
);

// ── Search ─────────────────────────────────────────────────────────────────────
const searchUrl = () => process.env.SEARCH_SERVICE_URL || 'http://localhost:5012';

router.post('/search/reindex',
  requirePermission('search', 'reindex'),
  auditLog('search.reindex', 'SearchIndex'),
  async (req, res) => {
    const r = await callService('POST', `${searchUrl()}/admin/reindex`, req.body, req.admin.email);
    res.status(r.status).json(r.data);
  }
);

router.post('/search/products/:id/hide',
  requirePermission('search', 'hide'),
  auditLog('search.hide', 'Product'),
  async (req, res) => {
    const r = await callService('POST', `${searchUrl()}/admin/hide/${req.params.id}`, {}, req.admin.email);
    res.status(r.status).json(r.data);
  }
);

// ── Notifications ──────────────────────────────────────────────────────────────
const notifUrl = () => process.env.NOTIFICATION_SERVICE_URL || 'http://localhost:5010';

router.post('/notifications/broadcast',
  requirePermission('notifications', 'broadcast'),
  auditLog('notification.broadcast', 'Notification'),
  async (req, res) => {
    const r = await callService('POST', `${notifUrl()}/admin/broadcast`, req.body, req.admin.email);
    res.status(r.status).json(r.data);
  }
);

// ── Analytics ──────────────────────────────────────────────────────────────────
const analyticsUrl = () => process.env.ANALYTICS_SERVICE_URL || 'http://localhost:5011';

// callServiceWithUser — like callService but also injects x-user: { role:'admin' }
// so services that scope queries on req.user.role respond with platform-wide data.
async function callServiceWithUser(method, url, body, adminEmail) {
  const opts = {
    method: method.toUpperCase(),
    headers: {
      'Content-Type': 'application/json',
      'x-admin-email': adminEmail,
      'x-user': JSON.stringify({ role: 'admin', email: adminEmail, sub: adminEmail })
    }
  };
  if (body && method !== 'GET') opts.body = JSON.stringify(body);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20000);
  try {
    const svcRes = await fetch(url, { ...opts, signal: controller.signal });
    clearTimeout(timer);
    const data = await svcRes.json().catch(() => ({}));
    return { ok: svcRes.ok, status: svcRes.status, data };
  } catch (err) {
    clearTimeout(timer);
    return { ok: false, status: 503, data: { error: err.message || 'Service unreachable' } };
  }
}

// Platform-wide analytics for the super dashboard
router.get('/analytics/platform/top-products', requirePermission('analytics', 'readAll'), async (req, res) => {
  const r = await callServiceWithUser('GET', `${analyticsUrl()}/top-products`, null, req.admin.email);
  res.status(r.status).json(r.data);
});

router.get('/analytics/platform/revenue', requirePermission('analytics', 'readAll'), async (req, res) => {
  const r = await callServiceWithUser('GET', `${analyticsUrl()}/revenue`, null, req.admin.email);
  res.status(r.status).json(r.data);
});

router.get('/analytics/platform/dashboard', requirePermission('analytics', 'readAll'), async (req, res) => {
  const r = await callServiceWithUser('GET', `${analyticsUrl()}/dashboard`, null, req.admin.email);
  res.status(r.status).json(r.data);
});

router.get('/analytics/platform/pulse', requirePermission('analytics', 'readAll'), async (req, res) => {
  const r = await callServiceWithUser('GET', `${analyticsUrl()}/admin/platform-pulse`, null, req.admin.email);
  res.status(r.status).json(r.data);
});

// Per-store analytics
router.get('/analytics/:storeId', requirePermission('analytics', 'readAll'), async (req, res) => {
  const r = await callServiceWithUser('GET', `${analyticsUrl()}/admin/store/${req.params.storeId}`, null, req.admin.email);
  res.status(r.status).json(r.data);
});

// Intelligence routes — anomaly detection and platform signals
router.get('/intelligence/anomalies', requirePermission('analytics', 'readAll'), async (req, res) => {
  const r = await callService('GET', `${analyticsUrl()}/admin/anomalies`, null, req.admin.email);
  res.status(r.status).json(r.data);
});

router.get('/catalog/products', requirePermission('catalog', 'approve'), async (req, res) => {
  const qs = new URLSearchParams(req.query).toString();
  const r  = await callService('GET', `${catalogUrl()}/products?${qs}`, null, req.admin.email);
  res.status(r.status).json(r.data);
});

// ── Inventory ──────────────────────────────────────────────────────────────────
const inventoryUrl = () => process.env.INVENTORY_SERVICE_URL || 'http://localhost:5006';

router.post('/inventory/:productId/adjust',
  requirePermission('inventory', 'adjust'),
  auditLog('inventory.adjust', 'Inventory'),
  async (req, res) => {
    const r = await callService('POST', `${inventoryUrl()}/admin/adjust/${req.params.productId}`, req.body, req.admin.email);
    res.status(r.status).json(r.data);
  }
);

router.post('/inventory/:productId/freeze',
  requirePermission('inventory', 'freeze'),
  auditLog('inventory.freeze', 'Inventory'),
  async (req, res) => {
    const r = await callService('POST', `${inventoryUrl()}/admin/freeze/${req.params.productId}`, req.body, req.admin.email);
    res.status(r.status).json(r.data);
  }
);

// ── Users ──────────────────────────────────────────────────────────────────────
const userUrl = () => process.env.USER_SERVICE_URL  || 'http://localhost:5013';
const authUrl = () => process.env.AUTH_SERVICE_URL  || 'http://localhost:5001';

router.get('/users/lookup', requirePermission('orders', 'read'), async (req, res) => {
  const qs = new URLSearchParams(req.query).toString();
  const r = await callService('GET', `${userUrl()}/admin/users/lookup?${qs}`, null, req.admin.email);
  res.status(r.status).json(r.data);
});

// Superuser only — list soft-deleted accounts
router.get('/users/deleted', (req, res, next) => {
  if (!req.admin.isSuperuser) return errorResponse(res, 403, 'Superuser only');
  next();
}, async (req, res) => {
  const qs = new URLSearchParams(req.query).toString();
  const r = await callService('GET', `${userUrl()}/admin/users/deleted?${qs}`, null, req.admin.email);
  res.status(r.status).json(r.data);
});

router.get('/users', requirePermission('auth', 'read'), async (req, res) => {
  // Auth-service is the source of truth — has every registered user, correct role/status.
  // User-service Profile is secondary (addresses, watchlist) — not used for the admin list.
  const qs = new URLSearchParams(req.query).toString();
  const r = await callService('GET', `${authUrl()}/admin/users?${qs}`, null, req.admin.email);
  res.status(r.status).json(r.data);
});

router.patch('/users/:userId/suspend', requirePermission('auth', 'ban'), auditLog('user.suspend', 'User'), async (req, res) => {
  const r = await callService('PATCH', `${userUrl()}/admin/users/${req.params.userId}/suspend`, req.body, req.admin.email);
  if (r.ok) {
    // Revoke active sessions so suspended user is kicked out immediately.
    callService('POST', `${authUrl()}/admin/users/${req.params.userId}/revoke-sessions`, {}, req.admin.email)
      .then(rv => {
        if (!rv.ok) console.error(`[PROXY] suspend: session revocation failed for ${req.params.userId} — status ${rv.status}`);
      })
      .catch(err => console.error(`[PROXY] suspend: session revocation error for ${req.params.userId}:`, err.message));
  }
  res.status(r.status).json(r.data);
});

router.patch('/users/:userId/ban', requirePermission('auth', 'ban'), auditLog('user.ban', 'User'), async (req, res) => {
  const r = await callService('PATCH', `${userUrl()}/admin/users/${req.params.userId}/ban`, req.body, req.admin.email);
  if (r.ok) {
    // Immediately revoke all refresh tokens so banned user cannot re-authenticate.
    // Fire-and-forget — ban itself already succeeded; log failures but don't block the response.
    callService('POST', `${authUrl()}/admin/users/${req.params.userId}/revoke-sessions`, {}, req.admin.email)
      .then(rv => {
        if (!rv.ok) console.error(`[PROXY] ban: session revocation failed for ${req.params.userId} — status ${rv.status}`);
        else console.log(`[PROXY] ban: revoked ${rv.data?.revokedCount ?? '?'} sessions for ${req.params.userId}`);
      })
      .catch(err => console.error(`[PROXY] ban: session revocation error for ${req.params.userId}:`, err.message));
  }
  res.status(r.status).json(r.data);
});

router.patch('/users/:userId/unban', requirePermission('auth', 'ban'), auditLog('user.unban', 'User'), async (req, res) => {
  const r = await callService('PATCH', `${userUrl()}/admin/users/${req.params.userId}/unban`, req.body, req.admin.email);
  res.status(r.status).json(r.data);
});

router.patch('/users/:userId/role', requirePermission('auth', 'write'), auditLog('user.roleChange', 'User'), async (req, res) => {
  const r = await callService('PATCH', `${userUrl()}/admin/users/${req.params.userId}/role`, req.body, req.admin.email);
  res.status(r.status).json(r.data);
});

// User profile detail (addresses, display name, etc.)
router.get('/users/:userId/profile', requirePermission('auth', 'read'), async (req, res) => {
  const r = await callService('GET', `${userUrl()}/admin/users/${req.params.userId}`, null, req.admin.email);
  res.status(r.status).json(r.data);
});

// Seller payout method — read by userId (user profile view)
router.get('/users/:userId/payout-method', requirePermission('auth', 'read'), async (req, res) => {
  const r = await callService('GET', `${userUrl()}/admin/users/${req.params.userId}/payout-method`, null, req.admin.email);
  res.status(r.status).json(r.data);
});

// Seller payout method — read by storeId (remittance auto-fill)
router.get('/sellers/:storeId/payout-method', requirePermission('auth', 'read'), async (req, res) => {
  const r = await callService('GET', `${userUrl()}/admin/sellers/${req.params.storeId}/payout-method`, null, req.admin.email);
  res.status(r.status).json(r.data);
});

// Hard-delete — superuser only, pre-condition gates enforced before forwarding
router.delete('/users/:userId',
  (req, res, next) => {
    if (!req.admin.isSuperuser) return errorResponse(res, 403, 'Superuser only');
    next();
  },
  auditLog('user.hardDelete', 'User'),
  async (req, res) => {
    const uid = req.params.userId;
    console.log(`[PROXY] hard-delete start — uid=${uid} admin=${req.admin.email}`);

    // Gate 1: block if user has active/held escrows
    const escrowCheck = await callService('GET', `${paymentUrl()}/admin/escrows/active-check?userId=${uid}`, null, req.admin.email);
    console.log(`[PROXY] gate1 escrow — ok=${escrowCheck.ok} status=${escrowCheck.status}`, JSON.stringify(escrowCheck.data));
    if (!escrowCheck.ok) {
      // Payment-service unreachable or erroring — log and allow.
      // Only hard-block on a confirmed 200 with hasActive:true (real financial hold).
      const svcDetail = escrowCheck.data?.message || escrowCheck.data?.error || `HTTP ${escrowCheck.status}`;
      console.warn(`[PROXY] hard-delete: escrow check non-OK for uid=${uid} (${escrowCheck.status}) — proceeding. Detail: ${svcDetail}`);
    } else if (escrowCheck.data?.hasActive) {
      return errorResponse(res, 400, `User has ${escrowCheck.data.count} active escrow(s). Resolve all financial obligations before deleting.`);
    }

    // Gate 2: block if user has open seller orders — look up storeId from profile first
    const profileLookup = await callService('GET', `${userUrl()}/admin/users/lookup?ids=${uid}`, null, req.admin.email);
    const storeId = profileLookup.data?.[uid]?.storeId;
    console.log(`[PROXY] gate2 profile — ok=${profileLookup.ok} storeId=${storeId || 'none'}`);
    if (storeId) {
      const orderCheck = await callService('GET', `${orderUrl()}/seller-orders-check?storeId=${storeId}`, null, req.admin.email);
      console.log(`[PROXY] gate2 orders — ok=${orderCheck.ok} status=${orderCheck.status}`, JSON.stringify(orderCheck.data));
      if (!orderCheck.ok) return errorResponse(res, 502, 'Could not verify seller orders — delete blocked for safety');
      if (orderCheck.data?.hasOpen) {
        return errorResponse(res, 400, `User has ${orderCheck.data.count} open seller order(s). Resolve them before deleting.`);
      }
    }

    // Delete Profile from user-service
    const r = await callService('DELETE', `${userUrl()}/admin/users/${uid}`, req.body, req.admin.email);
    console.log(`[PROXY] user-service delete — ok=${r.ok} status=${r.status}`, JSON.stringify(r.data));
    if (!r.ok) return res.status(r.status).json(r.data);

    // Delete User record + refresh tokens from auth-service (the record the user list is sourced from)
    const authDel = await callService('DELETE', `${authUrl()}/admin/users/${uid}`, {}, req.admin.email);
    console.log(`[PROXY] auth-service delete — ok=${authDel.ok} status=${authDel.status}`, JSON.stringify(authDel.data));
    if (!authDel.ok && authDel.status !== 404) {
      // Profile already gone; log the partial state but still surface the error
      console.error(`[PROXY] hard-delete partial: profile deleted but auth record removal failed for uid=${uid}`);
      return res.status(502).json({ error: 'Profile deleted but auth record removal failed — contact support', uid });
    }
    // 404 from auth-service = user record was never there (data inconsistency, or already cleaned up)
    // Nothing to remove — treat as success

    res.status(200).json({ userId: uid, deleted: true });
  }
);

// Force password reset — superuser only, no old password required
router.post('/users/:userId/force-password',
  (req, res, next) => { if (!req.admin.isSuperuser) return errorResponse(res, 403, 'Superuser only'); next(); },
  auditLog('user.forcePassword', 'User'),
  async (req, res) => {
    const r = await callService('POST', `${authUrl()}/admin/users/${req.params.userId}/force-password`, req.body, req.admin.email);
    res.status(r.status).json(r.data);
  }
);

// Force logout — revoke all refresh tokens (auth:ban permission)
router.post('/users/:userId/revoke-sessions',
  requirePermission('auth', 'ban'),
  auditLog('user.revokeSessions', 'User'),
  async (req, res) => {
    const r = await callService('POST', `${authUrl()}/admin/users/${req.params.userId}/revoke-sessions`, {}, req.admin.email);
    res.status(r.status).json(r.data);
  }
);

// ── Shipping ──────────────────────────────────────────────────────────────────
const shipUrl = () => process.env.SHIPPING_SERVICE_URL || 'http://localhost:5007';

router.get('/shipping', requirePermission('shipping', 'read'), async (req, res) => {
  const qs = new URLSearchParams(req.query).toString();
  const r = await callService('GET', `${shipUrl()}/admin?${qs}`, null, req.admin.email);
  res.status(r.status).json(r.data);
});

router.get('/shipping/unshipped', requirePermission('shipping', 'read'), async (req, res) => {
  const r = await callService('GET', `${shipUrl()}/admin/unshipped`, null, req.admin.email);
  res.status(r.status).json(r.data);
});

router.get('/shipping/stuck', requirePermission('shipping', 'read'), async (req, res) => {
  const r = await callService('GET', `${shipUrl()}/admin/stuck-in-transit`, null, req.admin.email);
  res.status(r.status).json(r.data);
});

router.patch('/shipping/:id/force-status', requirePermission('shipping', 'forceStatus'), auditLog('shipping.forceStatus', 'Shipment'), async (req, res) => {
  const r = await callService('PATCH', `${shipUrl()}/admin/${req.params.id}/force-status`, req.body, req.admin.email);
  res.status(r.status).json(r.data);
});

router.patch('/shipping/:id/mark-delivered', requirePermission('shipping', 'forceStatus'), auditLog('shipping.markDelivered', 'Shipment'), async (req, res) => {
  const r = await callService('PATCH', `${shipUrl()}/admin/${req.params.id}/mark-delivered`, req.body, req.admin.email);
  res.status(r.status).json(r.data);
});

// ── Messages ──────────────────────────────────────────────────────────────────
const msgUrl = () => process.env.MESSAGING_SERVICE_URL || 'http://localhost:5009';

router.get('/messages/threads', requirePermission('messages', 'read'), async (req, res) => {
  const qs = new URLSearchParams(req.query).toString();
  const r = await callService('GET', `${msgUrl()}/admin/threads?${qs}`, null, req.admin.email);
  res.status(r.status).json(r.data);
});

router.get('/messages/threads/flagged', requirePermission('messages', 'read'), async (req, res) => {
  const r = await callService('GET', `${msgUrl()}/admin/threads/flagged`, null, req.admin.email);
  res.status(r.status).json(r.data);
});

router.get('/messages/threads/disputes', requirePermission('messages', 'read'), async (req, res) => {
  const r = await callService('GET', `${msgUrl()}/admin/threads/disputes`, null, req.admin.email);
  res.status(r.status).json(r.data);
});

router.get('/messages/thread/:threadId', requirePermission('messages', 'read'), async (req, res) => {
  const r = await callService('GET', `${msgUrl()}/thread/${req.params.threadId}/admin`, null, req.admin.email);
  res.status(r.status).json(r.data);
});

router.patch('/messages/thread/:threadId/suspend', requirePermission('messages', 'moderate'), auditLog('message.suspendThread', 'Thread'), async (req, res) => {
  const r = await callService('PATCH', `${msgUrl()}/admin/threads/${req.params.threadId}/suspend`, req.body, req.admin.email);
  res.status(r.status).json(r.data);
});

router.post('/messages/thread/:threadId/system-message', requirePermission('messages', 'inject'), auditLog('message.inject', 'Thread'), async (req, res) => {
  const r = await callService('POST', `${msgUrl()}/admin/threads/${req.params.threadId}/system-message`, req.body, req.admin.email);
  res.status(r.status).json(r.data);
});

router.delete('/messages/message/:messageId', requirePermission('messages', 'moderate'), auditLog('message.hardDelete', 'Message'), async (req, res) => {
  const r = await callService('DELETE', `${msgUrl()}/admin/messages/${req.params.messageId}`, req.body, req.admin.email);
  res.status(r.status).json(r.data);
});

router.get('/messages/banned-users', requirePermission('messages', 'ban'), async (req, res) => {
  const r = await callService('GET', `${msgUrl()}/admin/banned-users`, null, req.admin.email);
  res.status(r.status).json(r.data);
});

router.post('/messages/ban/:userId', requirePermission('messages', 'ban'), auditLog('message.ban', 'User'), async (req, res) => {
  const r = await callService('POST', `${msgUrl()}/admin/ban/${req.params.userId}`, req.body, req.admin.email);
  res.status(r.status).json(r.data);
});

router.delete('/messages/ban/:userId', requirePermission('messages', 'ban'), auditLog('message.unban', 'User'), async (req, res) => {
  const r = await callService('DELETE', `${msgUrl()}/admin/ban/${req.params.userId}`, req.body, req.admin.email);
  res.status(r.status).json(r.data);
});

router.post('/messages/admin-initiate', requirePermission('messages', 'inject'), auditLog('message.adminInitiate', 'Thread'), async (req, res) => {
  const r = await callService('POST', `${msgUrl()}/admin/initiate-thread`, req.body, req.admin.email);
  res.status(r.status).json(r.data);
});

// ── Notifications (extended) ──────────────────────────────────────────────────
// (existing broadcast route stays; these extend it)

router.get('/notifications/logs', requirePermission('notifications', 'read'), async (req, res) => {
  const qs = new URLSearchParams(req.query).toString();
  const r = await callService('GET', `${notifUrl()}/admin/logs?${qs}`, null, req.admin.email);
  res.status(r.status).json(r.data);
});

router.get('/notifications/templates', requirePermission('notifications', 'editTemplates'), async (req, res) => {
  const r = await callService('GET', `${notifUrl()}/admin/templates`, null, req.admin.email);
  res.status(r.status).json(r.data);
});

router.patch('/notifications/templates/:type', requirePermission('notifications', 'editTemplates'), auditLog('notification.editTemplate', 'NotificationTemplate'), async (req, res) => {
  const r = await callService('PATCH', `${notifUrl()}/admin/templates/${req.params.type}`, req.body, req.admin.email);
  res.status(r.status).json(r.data);
});

router.delete('/notifications/:id', requirePermission('notifications', 'send'), auditLog('notification.delete', 'Notification'), async (req, res) => {
  const r = await callService('DELETE', `${notifUrl()}/admin/notifications/${req.params.id}`, null, req.admin.email);
  res.status(r.status).json(r.data);
});

router.get('/notifications/stats', requirePermission('notifications', 'read'), async (req, res) => {
  const r = await callService('GET', `${notifUrl()}/admin/notifications/stats`, null, req.admin.email);
  res.status(r.status).json(r.data);
});

// ── Inventory (extended) ──────────────────────────────────────────────────────
router.get('/inventory', requirePermission('inventory', 'read'), async (req, res) => {
  const qs = new URLSearchParams(req.query).toString();
  const r = await callService('GET', `${inventoryUrl()}/admin/inventory?${qs}`, null, req.admin.email);
  res.status(r.status).json(r.data);
});

router.get('/inventory/out-of-stock', requirePermission('inventory', 'read'), async (req, res) => {
  const r = await callService('GET', `${inventoryUrl()}/admin/inventory/out-of-stock`, null, req.admin.email);
  res.status(r.status).json(r.data);
});

router.get('/inventory/dormant', requirePermission('inventory', 'read'), async (req, res) => {
  const r = await callService('GET', `${inventoryUrl()}/admin/inventory/dormant-stock`, null, req.admin.email);
  res.status(r.status).json(r.data);
});

// ── Sellers (extended) ────────────────────────────────────────────────────────
router.patch('/sellers/:storeId/tier', requirePermission('sellers', 'tier'), auditLog('seller.tierChange', 'Store'), async (req, res) => {
  const r = await callService('PATCH', `${sellerUrl()}/admin/${req.params.storeId}/tier`, req.body, req.admin.email);
  res.status(r.status).json(r.data);
});

router.get('/sellers/dormant', requirePermission('sellers', 'read'), async (req, res) => {
  const r = await callService('GET', `${sellerUrl()}/admin/stores/dormant`, null, req.admin.email);
  res.status(r.status).json(r.data);
});

router.get('/sellers/:storeId/profile', requirePermission('sellers', 'read'), async (req, res) => {
  const r = await callService('GET', `${sellerUrl()}/admin/stores/${req.params.storeId}/profile`, null, req.admin.email);
  res.status(r.status).json(r.data);
});

// S20 — Update seller Stripe Connect status
router.patch('/sellers/:storeId/connect-status', requirePermission('sellers', 'verify'), auditLog('seller.connectStatus', 'Store'), async (req, res) => {
  const r = await callService('PATCH', `${sellerUrl()}/admin/stores/${req.params.storeId}/connect-status`, req.body, req.admin.email);
  res.status(r.status).json(r.data);
});

// ── Catalog (extended) ────────────────────────────────────────────────────────
router.patch('/catalog/products/:id/force-status', requirePermission('catalog', 'approve'), auditLog('catalog.forceStatus', 'Product'), async (req, res) => {
  const r = await callService('PATCH', `${catalogUrl()}/admin/products/${req.params.id}/force-status`, req.body, req.admin.email);
  res.status(r.status).json(r.data);
});

router.delete('/catalog/products/:id/hard-delete', requirePermission('catalog', 'approve'), auditLog('catalog.hardDelete', 'Product'), async (req, res) => {
  const r = await callService('DELETE', `${catalogUrl()}/products/${req.params.id}`, req.body, req.admin.email);
  res.status(r.status).json(r.data);
});

router.get('/catalog/products/admin', requirePermission('catalog', 'approve'), async (req, res) => {
  const qs = new URLSearchParams(req.query).toString();
  const r = await callService('GET', `${catalogUrl()}/admin/products?${qs}`, null, req.admin.email);
  res.status(r.status).json(r.data);
});

router.get('/catalog/stale', requirePermission('catalog', 'approve'), async (req, res) => {
  const r = await callService('GET', `${catalogUrl()}/admin/products/stale`, null, req.admin.email);
  res.status(r.status).json(r.data);
});

// ── Payments (extended) ───────────────────────────────────────────────────────
router.patch('/payments/:orderId/split-refund', requirePermission('payments', 'splitRefund'), auditLog('payment.splitRefund', 'Payment'), async (req, res) => {
  const r = await callService('PATCH', `${paymentUrl()}/admin/escrows/${req.params.orderId}/split-refund`, req.body, req.admin.email);
  res.status(r.status).json(r.data);
});

router.patch('/payments/:orderId/extend-dispute', requirePermission('payments', 'freeze'), auditLog('payment.extendDispute', 'Payment'), async (req, res) => {
  const r = await callService('PATCH', `${paymentUrl()}/admin/escrows/${req.params.orderId}/extend-dispute-window`, req.body, req.admin.email);
  res.status(r.status).json(r.data);
});

router.post('/payments/hold-payouts/:sellerId', requirePermission('payments', 'payoutHold'), auditLog('payment.payoutHold', 'Seller'), async (req, res) => {
  const r = await callService('POST', `${paymentUrl()}/admin/payments/hold-payouts/${req.params.sellerId}`, req.body, req.admin.email);
  res.status(r.status).json(r.data);
});

router.delete('/payments/hold-payouts/:sellerId', requirePermission('payments', 'payoutHold'), auditLog('payment.liftPayoutHold', 'Seller'), async (req, res) => {
  const r = await callService('DELETE', `${paymentUrl()}/admin/payments/hold-payouts/${req.params.sellerId}`, null, req.admin.email);
  res.status(r.status).json(r.data);
});

router.get('/payments/payout-holds', requirePermission('payments', 'payoutHold'), async (req, res) => {
  const r = await callService('GET', `${paymentUrl()}/admin/payments/payout-holds`, null, req.admin.email);
  res.status(r.status).json(r.data);
});

// S22 — Payment business rules config (sellerAcceptanceHours, codExpiryDays, defaultCurrency, taxRates)
router.get('/payments/platform-config', requirePermission('payments', 'read'), async (req, res) => {
  const r = await callService('GET', `${paymentUrl()}/admin/platform-config`, null, req.admin.email);
  res.status(r.status).json(r.data);
});

router.patch('/payments/platform-config',
  requirePermission('payments', 'read'),
  auditLog('payment.platformConfigUpdate', 'PlatformConfig'),
  async (req, res) => {
    const r = await callService('PATCH', `${paymentUrl()}/admin/platform-config`, req.body, req.admin.email);
    res.status(r.status).json(r.data);
  }
);

router.patch('/payments/platform-config/tax-rates',
  requirePermission('payments', 'read'),
  auditLog('payment.taxRateUpdate', 'PlatformConfig'),
  async (req, res) => {
    const r = await callService('PATCH', `${paymentUrl()}/admin/platform-config/tax-rates`, req.body, req.admin.email);
    res.status(r.status).json(r.data);
  }
);

// S23 — Manual Remittance
router.get('/payments/remittances', requirePermission('payments', 'remit'), async (req, res) => {
  const qs = new URLSearchParams(req.query).toString();
  const r  = await callService('GET', `${paymentUrl()}/admin/payments/remittances${qs ? '?' + qs : ''}`, null, req.admin.email);
  res.status(r.status).json(r.data);
});
router.post('/payments/remittances',
  requirePermission('payments', 'remit'),
  auditLog('payment.remittanceCreated', 'Remittance'),
  async (req, res) => {
    const r = await callService('POST', `${paymentUrl()}/admin/payments/remittances`, req.body, req.admin.email);
    res.status(r.status).json(r.data);
  }
);
router.patch('/payments/remittances/:id/mark-paid',
  requirePermission('payments', 'remit'),
  auditLog('payment.remittanceMarkedPaid', 'Remittance'),
  async (req, res) => {
    const r = await callService('PATCH', `${paymentUrl()}/admin/payments/remittances/${req.params.id}/mark-paid`, req.body, req.admin.email);
    res.status(r.status).json(r.data);
  }
);

// Sellers with outstanding payout balances — enriched with store name + account email
router.get('/payments/sellers-with-payouts', requirePermission('payments', 'remit'), async (req, res) => {
    const r = await callService('GET', `${paymentUrl()}/admin/payments/sellers-with-payouts`, null, req.admin.email);
    if (!r.ok) return res.status(r.status).json(r.data);
    const sellers = r.data.sellers || [];
    if (!sellers.length) return res.json({ sellers: [] });
    const enriched = await Promise.all(sellers.map(async s => {
        try {
            const sr = await callService('GET', `${sellerUrl()}/admin/stores/${s.storeId}/profile`, null, req.admin.email);
            const storeName    = sr.ok ? (sr.data.name || '—') : '—';
            const sellerUserId = sr.ok ? sr.data.sellerId?.toString() : null;
            let email = '';
            if (sellerUserId) {
                const ur = await callService('GET', `${userUrl()}/admin/users/${sellerUserId}`, null, req.admin.email);
                email = ur.ok ? (ur.data.profile?.email || '') : '';
            }
            return { ...s, storeName, email };
        } catch { return { ...s, storeName: '—', email: '' }; }
    }));
    res.json({ sellers: enriched });
});

// ── Search (extended) ─────────────────────────────────────────────────────────
router.get('/search/health', requirePermission('search', 'read'), async (req, res) => {
  const r = await callService('GET', `${searchUrl()}/admin/index-health`, null, req.admin.email);
  res.status(r.status).json(r.data);
});

router.post('/search/reindex-all', requirePermission('search', 'reindex'), auditLog('search.reindexAll', 'SearchIndex'), async (req, res) => {
  const r = await callService('POST', `${searchUrl()}/admin/reindex-all`, req.body, req.admin.email);
  res.status(r.status).json(r.data);
});

router.patch('/search/products/:id/unhide', requirePermission('search', 'hide'), auditLog('search.unhide', 'Product'), async (req, res) => {
  const r = await callService('PATCH', `${searchUrl()}/admin/${req.params.id}/unhide`, null, req.admin.email);
  res.status(r.status).json(r.data);
});

router.post('/search/cache/clear', requirePermission('search', 'reindex'), async (req, res) => {
  const r = await callService('POST', `${searchUrl()}/admin/cache/clear`, null, req.admin.email);
  res.status(r.status).json(r.data);
});

router.get('/search/autocomplete', requirePermission('search', 'autocomplete'), async (req, res) => {
  const r = await callService('GET', `${searchUrl()}/admin/autocomplete`, null, req.admin.email);
  res.status(r.status).json(r.data);
});

// ── Inventory (additional) ────────────────────────────────────────────────────
router.get('/inventory/reservation-summary', requirePermission('inventory', 'read'), async (req, res) => {
  const r = await callService('GET', `${inventoryUrl()}/admin/inventory/reservation-summary`, null, req.admin.email);
  res.status(r.status).json(r.data);
});

// ── Search autocomplete delete ────────────────────────────────────────────────
router.delete('/search/autocomplete/:term', requirePermission('search', 'autocomplete'), auditLog('search.deleteAutocomplete', 'SearchIndex'), async (req, res) => {
  const r = await callService('DELETE', `${searchUrl()}/admin/autocomplete/${req.params.term}`, null, req.admin.email);
  res.status(r.status).json(r.data);
});

// ── Notifications resend ──────────────────────────────────────────────────────
router.post('/notifications/resend/:id', requirePermission('notifications', 'send'), auditLog('notification.resend', 'Notification'), async (req, res) => {
  const r = await callService('POST', `${notifUrl()}/admin/notifications/${req.params.id}/resend`, null, req.admin.email);
  res.status(r.status).json(r.data);
});

// ── System config (platform fee / dispute window) — proxy to admin-service self ──
// These are handled directly in admin-service /system routes — no proxy needed.

// ── Audit Log ─────────────────────────────────────────────────────────────────
router.get('/audit', requirePermission('audit', 'readAll'), async (req, res) => {
  const qs = new URLSearchParams(req.query).toString();
  // Audit is in admin-service itself
  const r = await callService('GET', `${process.env.ADMIN_SERVICE_URL || 'http://localhost:5014'}/admin/system/audit?${qs}`, null, req.admin.email);
  res.status(r.status).json(r.data);
});

module.exports = router;
