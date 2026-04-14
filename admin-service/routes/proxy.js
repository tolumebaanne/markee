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
  const timer = setTimeout(() => controller.abort(), 8000);
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
  const r = await callServiceAsAdmin('GET', `${catalogUrl()}/products/pending-review`, null, req.admin.email);
  res.status(r.status).json(r.data);
});

router.post('/catalog/products/:id/approve',
  requirePermission('catalog', 'approve'),
  auditLog('catalog.approve', 'Product'),
  async (req, res) => {
    const r = await callServiceAsAdmin('POST', `${catalogUrl()}/products/${req.params.id}/approve`, req.body, req.admin.email);
    res.status(r.status).json(r.data);
  }
);

router.post('/catalog/products/:id/reject',
  requirePermission('catalog', 'reject'),
  auditLog('catalog.reject', 'Product'),
  async (req, res) => {
    const r = await callServiceAsAdmin('POST', `${catalogUrl()}/products/${req.params.id}/reject`, req.body, req.admin.email);
    res.status(r.status).json(r.data);
  }
);

router.post('/catalog/products/:id/feature',
  requirePermission('catalog', 'feature'),
  auditLog('catalog.feature', 'Product'),
  async (req, res) => {
    const r = await callServiceAsAdmin('POST', `${catalogUrl()}/products/${req.params.id}/feature`, req.body, req.admin.email);
    res.status(r.status).json(r.data);
  }
);

// ── Listing Review (reviewer-facing catalog proxy routes) ─────────────────────

router.get('/catalog/products/review/unassigned',
  requireReviewPermission('canReview'),
  async (req, res) => {
    const r = await callServiceAsAdmin('GET', `${catalogUrl()}/products/review/unassigned`, null, req.admin.email);
    res.status(r.status).json(r.data);
  }
);

router.get('/catalog/products/review/assigned/:adminId',
  requireReviewPermission('canReview'),
  async (req, res) => {
    const r = await callServiceAsAdmin('GET', `${catalogUrl()}/products/review/assigned/${req.params.adminId}`, null, req.admin.email);
    res.status(r.status).json(r.data);
  }
);

router.get('/catalog/products/review/history',
  requireReviewPermission('canReview'),
  async (req, res) => {
    const qs = new URLSearchParams(req.query).toString();
    const r  = await callServiceAsAdmin('GET', `${catalogUrl()}/products/review/history?${qs}`, null, req.admin.email);
    res.status(r.status).json(r.data);
  }
);

router.post('/catalog/products/:id/disapprove',
  requireReviewPermission('canReview'),
  auditLog('listingReview.disapprove', 'Product'),
  async (req, res) => {
    const r = await callServiceAsAdmin('POST', `${catalogUrl()}/products/${req.params.id}/disapprove`, req.body, req.admin.email);
    res.status(r.status).json(r.data);
  }
);

router.post('/catalog/products/review/assign',
  requireReviewPermission('canAssign'),
  auditLog('listingReview.assign', 'Product'),
  async (req, res) => {
    const r = await callServiceAsAdmin('POST', `${catalogUrl()}/products/review/assign`, req.body, req.admin.email);
    res.status(r.status).json(r.data);
  }
);

router.post('/catalog/products/review/reassign',
  requireReviewPermission('canAssign'),
  auditLog('listingReview.reassign', 'Product'),
  async (req, res) => {
    const r = await callServiceAsAdmin('POST', `${catalogUrl()}/products/review/reassign`, req.body, req.admin.email);
    res.status(r.status).json(r.data);
  }
);

router.post('/catalog/products/review/pullback',
  requireReviewPermission('canAssign'),
  auditLog('listingReview.pullback', 'Product'),
  async (req, res) => {
    const r = await callServiceAsAdmin('POST', `${catalogUrl()}/products/review/pullback`, req.body, req.admin.email);
    res.status(r.status).json(r.data);
  }
);

// ── Orders ─────────────────────────────────────────────────────────────────────
const orderUrl = () => process.env.ORDER_SERVICE_URL || 'http://localhost:5003';

router.get('/orders', requirePermission('orders', 'read'), async (req, res) => {
  const qs = new URLSearchParams(req.query).toString();
  const r  = await callServiceAsAdmin('GET', `${orderUrl()}/admin/orders?${qs}`, null, req.admin.email);
  res.status(r.status).json(r.data);
});

router.get('/orders/:id', requirePermission('orders', 'read'), async (req, res) => {
  const r = await callServiceAsAdmin('GET', `${orderUrl()}/admin/orders/${req.params.id}`, null, req.admin.email);
  res.status(r.status).json(r.data);
});

router.post('/orders/:id/force-status',
  requirePermission('orders', 'forceStatus'),
  auditLog('order.forceStatus', 'Order'),
  async (req, res) => {
    const r = await callServiceAsAdmin('POST', `${orderUrl()}/admin/orders/${req.params.id}/status`, req.body, req.admin.email);
    res.status(r.status).json(r.data);
  }
);

router.post('/orders/:id/cancel',
  requirePermission('orders', 'cancel'),
  auditLog('order.cancel', 'Order'),
  async (req, res) => {
    const r = await callServiceAsAdmin('POST', `${orderUrl()}/admin/orders/${req.params.id}/cancel`, req.body, req.admin.email);
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
    const r = await callServiceAsAdmin('DELETE', `${orderUrl()}/admin/orders/${req.params.id}`, null, req.admin.email);
    res.status(r.status).json(r.data);
  }
);

// ── Payments ──────────────────────────────────────────────────────────────────
const paymentUrl = () => process.env.PAYMENT_SERVICE_URL || 'http://localhost:5004';

router.get('/payments/admin', requirePermission('payments', 'read'), async (req, res) => {
  const qs = new URLSearchParams(req.query).toString();
  const r  = await callServiceAsAdmin('GET', `${paymentUrl()}/admin/escrows?${qs}`, null, req.admin.email);
  res.status(r.status).json(r.data);
});

router.get('/payments/disputes', requirePermission('payments', 'read'), async (req, res) => {
  const r = await callServiceAsAdmin('GET', `${paymentUrl()}/admin/disputes`, null, req.admin.email);
  res.status(r.status).json(r.data);
});

router.get('/payments/summary', requirePermission('payments', 'read'), async (req, res) => {
  const r = await callServiceAsAdmin('GET', `${paymentUrl()}/admin/summary`, null, req.admin.email);
  res.status(r.status).json(r.data);
});

router.patch('/payments/:orderId/freeze',
  requirePermission('payments', 'freeze'),
  auditLog('payment.freeze', 'Payment'),
  async (req, res) => {
    const r = await callServiceAsAdmin('PATCH', `${paymentUrl()}/admin/escrows/${req.params.orderId}/freeze`, req.body, req.admin.email);
    res.status(r.status).json(r.data);
  }
);

router.post('/payments/:orderId/force-release',
  requirePermission('payments', 'release'),
  auditLog('payment.forceRelease', 'Payment'),
  async (req, res) => {
    const r = await callServiceAsAdmin('POST', `${paymentUrl()}/admin/escrows/${req.params.orderId}/force-release`, req.body, req.admin.email);
    res.status(r.status).json(r.data);
  }
);

router.post('/payments/:id/refund',
  requirePermission('payments', 'refund'),
  auditLog('payment.refund', 'Payment'),
  async (req, res) => {
    const r = await callServiceAsAdmin('POST', `${paymentUrl()}/refund/${req.params.id}`, req.body, req.admin.email);
    res.status(r.status).json(r.data);
  }
);

router.post('/payments/:id/release',
  requirePermission('payments', 'release'),
  auditLog('payment.release', 'Payment'),
  async (req, res) => {
    const r = await callServiceAsAdmin('PATCH', `${paymentUrl()}/release/${req.params.id}`, req.body, req.admin.email);
    res.status(r.status).json(r.data);
  }
);

// ── Sellers ────────────────────────────────────────────────────────────────────
const sellerUrl = () => process.env.SELLER_SERVICE_URL || 'http://localhost:5005';

router.get('/sellers', requirePermission('sellers', 'read'), async (req, res) => {
  const qs = new URLSearchParams(req.query).toString();
  const r  = await callServiceAsAdmin('GET', `${sellerUrl()}/admin/stores?${qs}`, null, req.admin.email);
  res.status(r.status).json(r.data);
});

router.post('/sellers/:storeId/verify',
  requirePermission('sellers', 'verify'),
  auditLog('seller.verify', 'Store'),
  async (req, res) => {
    const r = await callServiceAsAdmin('POST', `${sellerUrl()}/admin/${req.params.storeId}/verify`, {}, req.admin.email);
    res.status(r.status).json(r.data);
  }
);

router.post('/sellers/:storeId/unverify',
  requirePermission('sellers', 'verify'),
  auditLog('seller.unverify', 'Store'),
  async (req, res) => {
    const r = await callServiceAsAdmin('POST', `${sellerUrl()}/admin/${req.params.storeId}/unverify`, {}, req.admin.email);
    res.status(r.status).json(r.data);
  }
);

router.post('/sellers/:storeId/suspend',
  requirePermission('sellers', 'suspend'),
  auditLog('seller.suspend', 'Store'),
  async (req, res) => {
    const r = await callServiceAsAdmin('POST', `${sellerUrl()}/admin/${req.params.storeId}/suspend`, req.body, req.admin.email);
    res.status(r.status).json(r.data);
  }
);

router.post('/sellers/:storeId/restore',
  requirePermission('sellers', 'suspend'),
  auditLog('seller.restore', 'Store'),
  async (req, res) => {
    const r = await callServiceAsAdmin('POST', `${sellerUrl()}/admin/${req.params.storeId}/restore`, req.body, req.admin.email);
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

router.delete('/reviews/:id',
  requirePermission('reviews', 'delete'),
  auditLog('review.delete', 'Review'),
  async (req, res) => {
    const r = await callService('DELETE', `${reviewUrl()}/admin/${req.params.id}`, { reason: req.body.reason }, req.admin.email);
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

// callServiceAsAdmin — like callService but includes x-user: { role:'admin' }
// so analytics/other services that scope on req.user.role respond with platform-wide data.
async function callServiceAsAdmin(method, url, body, adminEmail) {
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
  const timer = setTimeout(() => controller.abort(), 8000);
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
  const r = await callServiceAsAdmin('GET', `${analyticsUrl()}/top-products`, null, req.admin.email);
  res.status(r.status).json(r.data);
});

router.get('/analytics/platform/revenue', requirePermission('analytics', 'readAll'), async (req, res) => {
  const r = await callServiceAsAdmin('GET', `${analyticsUrl()}/revenue`, null, req.admin.email);
  res.status(r.status).json(r.data);
});

router.get('/analytics/platform/dashboard', requirePermission('analytics', 'readAll'), async (req, res) => {
  const r = await callServiceAsAdmin('GET', `${analyticsUrl()}/dashboard`, null, req.admin.email);
  res.status(r.status).json(r.data);
});

router.get('/analytics/platform/pulse', requirePermission('analytics', 'readAll'), async (req, res) => {
  const r = await callServiceAsAdmin('GET', `${analyticsUrl()}/admin/platform-pulse`, null, req.admin.email);
  res.status(r.status).json(r.data);
});

// Per-store analytics
router.get('/analytics/:storeId', requirePermission('analytics', 'readAll'), async (req, res) => {
  const r = await callService('GET', `${analyticsUrl()}/admin/store/${req.params.storeId}`, null, req.admin.email);
  res.status(r.status).json(r.data);
});

// Intelligence routes — anomaly detection and platform signals
router.get('/intelligence/anomalies', requirePermission('analytics', 'readAll'), async (req, res) => {
  const r = await callServiceAsAdmin('GET', `${analyticsUrl()}/admin/anomalies`, null, req.admin.email);
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
    const r = await callServiceAsAdmin('POST', `${inventoryUrl()}/admin/adjust/${req.params.productId}`, req.body, req.admin.email);
    res.status(r.status).json(r.data);
  }
);

router.post('/inventory/:productId/freeze',
  requirePermission('inventory', 'freeze'),
  auditLog('inventory.freeze', 'Inventory'),
  async (req, res) => {
    const r = await callServiceAsAdmin('POST', `${inventoryUrl()}/admin/freeze/${req.params.productId}`, req.body, req.admin.email);
    res.status(r.status).json(r.data);
  }
);

// ── Users ──────────────────────────────────────────────────────────────────────
const userUrl = () => process.env.USER_SERVICE_URL  || 'http://localhost:5013';
const authUrl = () => process.env.AUTH_SERVICE_URL  || 'http://localhost:5001';

router.get('/users/lookup', requirePermission('orders', 'read'), async (req, res) => {
  const qs = new URLSearchParams(req.query).toString();
  const r = await callServiceAsAdmin('GET', `${userUrl()}/admin/users/lookup?${qs}`, null, req.admin.email);
  res.status(r.status).json(r.data);
});

// Superuser only — list soft-deleted accounts
router.get('/users/deleted', (req, res, next) => {
  if (!req.admin.isSuperuser) return errorResponse(res, 403, 'Superuser only');
  next();
}, async (req, res) => {
  const qs = new URLSearchParams(req.query).toString();
  const r = await callServiceAsAdmin('GET', `${userUrl()}/admin/users/deleted?${qs}`, null, req.admin.email);
  res.status(r.status).json(r.data);
});

router.get('/users', requirePermission('auth', 'read'), async (req, res) => {
  // Auth-service is the source of truth — has every registered user, correct role/status.
  // User-service Profile is secondary (addresses, watchlist) — not used for the admin list.
  const qs = new URLSearchParams(req.query).toString();
  const r = await callServiceAsAdmin('GET', `${authUrl()}/admin/users?${qs}`, null, req.admin.email);
  res.status(r.status).json(r.data);
});

router.patch('/users/:userId/suspend', requirePermission('auth', 'ban'), auditLog('user.suspend', 'User'), async (req, res) => {
  const r = await callServiceAsAdmin('PATCH', `${userUrl()}/admin/users/${req.params.userId}/suspend`, req.body, req.admin.email);
  res.status(r.status).json(r.data);
});

router.patch('/users/:userId/ban', requirePermission('auth', 'ban'), auditLog('user.ban', 'User'), async (req, res) => {
  const r = await callServiceAsAdmin('PATCH', `${userUrl()}/admin/users/${req.params.userId}/ban`, req.body, req.admin.email);
  res.status(r.status).json(r.data);
});

router.patch('/users/:userId/unban', requirePermission('auth', 'ban'), auditLog('user.unban', 'User'), async (req, res) => {
  const r = await callServiceAsAdmin('PATCH', `${userUrl()}/admin/users/${req.params.userId}/unban`, req.body, req.admin.email);
  res.status(r.status).json(r.data);
});

router.patch('/users/:userId/role', requirePermission('auth', 'write'), auditLog('user.roleChange', 'User'), async (req, res) => {
  const r = await callServiceAsAdmin('PATCH', `${userUrl()}/admin/users/${req.params.userId}/role`, req.body, req.admin.email);
  res.status(r.status).json(r.data);
});

// User profile detail (addresses, display name, etc.)
router.get('/users/:userId/profile', requirePermission('auth', 'read'), async (req, res) => {
  const r = await callServiceAsAdmin('GET', `${userUrl()}/admin/users/${req.params.userId}`, null, req.admin.email);
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

    // Gate 1: block if user has active/held escrows
    const escrowCheck = await callServiceAsAdmin('GET', `${paymentUrl()}/admin/escrows/active-check?userId=${uid}`, null, req.admin.email);
    if (!escrowCheck.ok) return errorResponse(res, 502, 'Could not verify escrow state — delete blocked for safety');
    if (escrowCheck.data?.hasActive) {
      return errorResponse(res, 400, `User has ${escrowCheck.data.count} active escrow(s). Resolve all financial obligations before deleting.`);
    }

    // Gate 2: block if user has open seller orders — look up storeId from profile first
    const profileLookup = await callServiceAsAdmin('GET', `${userUrl()}/admin/users/lookup?ids=${uid}`, null, req.admin.email);
    const storeId = profileLookup.data?.[uid]?.storeId;
    if (storeId) {
      const orderCheck = await callServiceAsAdmin('GET', `${orderUrl()}/seller-orders-check?storeId=${storeId}`, null, req.admin.email);
      if (!orderCheck.ok) return errorResponse(res, 502, 'Could not verify seller orders — delete blocked for safety');
      if (orderCheck.data?.hasOpen) {
        return errorResponse(res, 400, `User has ${orderCheck.data.count} open seller order(s). Resolve them before deleting.`);
      }
    }

    const r = await callServiceAsAdmin('DELETE', `${userUrl()}/admin/users/${uid}`, req.body, req.admin.email);
    res.status(r.status).json(r.data);
  }
);

// ── Shipping ──────────────────────────────────────────────────────────────────
const shipUrl = () => process.env.SHIPPING_SERVICE_URL || 'http://localhost:5007';

router.get('/shipping', requirePermission('shipping', 'read'), async (req, res) => {
  const qs = new URLSearchParams(req.query).toString();
  const r = await callServiceAsAdmin('GET', `${shipUrl()}/admin?${qs}`, null, req.admin.email);
  res.status(r.status).json(r.data);
});

router.get('/shipping/unshipped', requirePermission('shipping', 'read'), async (req, res) => {
  const r = await callServiceAsAdmin('GET', `${shipUrl()}/admin/unshipped`, null, req.admin.email);
  res.status(r.status).json(r.data);
});

router.get('/shipping/stuck', requirePermission('shipping', 'read'), async (req, res) => {
  const r = await callServiceAsAdmin('GET', `${shipUrl()}/admin/stuck-in-transit`, null, req.admin.email);
  res.status(r.status).json(r.data);
});

router.patch('/shipping/:id/force-status', requirePermission('shipping', 'forceStatus'), auditLog('shipping.forceStatus', 'Shipment'), async (req, res) => {
  const r = await callServiceAsAdmin('PATCH', `${shipUrl()}/admin/${req.params.id}/force-status`, req.body, req.admin.email);
  res.status(r.status).json(r.data);
});

router.patch('/shipping/:id/mark-delivered', requirePermission('shipping', 'forceStatus'), auditLog('shipping.markDelivered', 'Shipment'), async (req, res) => {
  const r = await callServiceAsAdmin('PATCH', `${shipUrl()}/admin/${req.params.id}/mark-delivered`, req.body, req.admin.email);
  res.status(r.status).json(r.data);
});

// ── Messages ──────────────────────────────────────────────────────────────────
const msgUrl = () => process.env.MESSAGING_SERVICE_URL || 'http://localhost:5009';

router.get('/messages/threads', requirePermission('messages', 'read'), async (req, res) => {
  const qs = new URLSearchParams(req.query).toString();
  const r = await callServiceAsAdmin('GET', `${msgUrl()}/admin/threads?${qs}`, null, req.admin.email);
  res.status(r.status).json(r.data);
});

router.get('/messages/threads/flagged', requirePermission('messages', 'read'), async (req, res) => {
  const r = await callServiceAsAdmin('GET', `${msgUrl()}/admin/threads/flagged`, null, req.admin.email);
  res.status(r.status).json(r.data);
});

router.get('/messages/threads/disputes', requirePermission('messages', 'read'), async (req, res) => {
  const r = await callServiceAsAdmin('GET', `${msgUrl()}/admin/threads/disputes`, null, req.admin.email);
  res.status(r.status).json(r.data);
});

router.get('/messages/thread/:threadId', requirePermission('messages', 'read'), async (req, res) => {
  const r = await callServiceAsAdmin('GET', `${msgUrl()}/thread/${req.params.threadId}/admin`, null, req.admin.email);
  res.status(r.status).json(r.data);
});

router.patch('/messages/thread/:threadId/suspend', requirePermission('messages', 'moderate'), auditLog('message.suspendThread', 'Thread'), async (req, res) => {
  const r = await callServiceAsAdmin('PATCH', `${msgUrl()}/admin/threads/${req.params.threadId}/suspend`, req.body, req.admin.email);
  res.status(r.status).json(r.data);
});

router.post('/messages/thread/:threadId/system-message', requirePermission('messages', 'inject'), auditLog('message.inject', 'Thread'), async (req, res) => {
  const r = await callServiceAsAdmin('POST', `${msgUrl()}/admin/threads/${req.params.threadId}/system-message`, req.body, req.admin.email);
  res.status(r.status).json(r.data);
});

router.delete('/messages/message/:messageId', requirePermission('messages', 'moderate'), auditLog('message.hardDelete', 'Message'), async (req, res) => {
  const r = await callServiceAsAdmin('DELETE', `${msgUrl()}/admin/messages/${req.params.messageId}`, req.body, req.admin.email);
  res.status(r.status).json(r.data);
});

router.get('/messages/banned-users', requirePermission('messages', 'ban'), async (req, res) => {
  const r = await callServiceAsAdmin('GET', `${msgUrl()}/admin/banned-users`, null, req.admin.email);
  res.status(r.status).json(r.data);
});

router.post('/messages/ban/:userId', requirePermission('messages', 'ban'), auditLog('message.ban', 'User'), async (req, res) => {
  const r = await callServiceAsAdmin('POST', `${msgUrl()}/admin/ban/${req.params.userId}`, req.body, req.admin.email);
  res.status(r.status).json(r.data);
});

router.delete('/messages/ban/:userId', requirePermission('messages', 'ban'), auditLog('message.unban', 'User'), async (req, res) => {
  const r = await callServiceAsAdmin('DELETE', `${msgUrl()}/admin/ban/${req.params.userId}`, req.body, req.admin.email);
  res.status(r.status).json(r.data);
});

// ── Notifications (extended) ──────────────────────────────────────────────────
// (existing broadcast route stays; these extend it)

router.get('/notifications/logs', requirePermission('notifications', 'read'), async (req, res) => {
  const qs = new URLSearchParams(req.query).toString();
  const r = await callServiceAsAdmin('GET', `${notifUrl()}/admin/logs?${qs}`, null, req.admin.email);
  res.status(r.status).json(r.data);
});

router.get('/notifications/templates', requirePermission('notifications', 'editTemplates'), async (req, res) => {
  const r = await callServiceAsAdmin('GET', `${notifUrl()}/admin/templates`, null, req.admin.email);
  res.status(r.status).json(r.data);
});

router.patch('/notifications/templates/:type', requirePermission('notifications', 'editTemplates'), auditLog('notification.editTemplate', 'NotificationTemplate'), async (req, res) => {
  const r = await callServiceAsAdmin('PATCH', `${notifUrl()}/admin/templates/${req.params.type}`, req.body, req.admin.email);
  res.status(r.status).json(r.data);
});

router.delete('/notifications/:id', requirePermission('notifications', 'send'), auditLog('notification.delete', 'Notification'), async (req, res) => {
  const r = await callServiceAsAdmin('DELETE', `${notifUrl()}/admin/notifications/${req.params.id}`, null, req.admin.email);
  res.status(r.status).json(r.data);
});

router.get('/notifications/stats', requirePermission('notifications', 'read'), async (req, res) => {
  const r = await callServiceAsAdmin('GET', `${notifUrl()}/admin/notifications/stats`, null, req.admin.email);
  res.status(r.status).json(r.data);
});

// ── Inventory (extended) ──────────────────────────────────────────────────────
router.get('/inventory', requirePermission('inventory', 'read'), async (req, res) => {
  const qs = new URLSearchParams(req.query).toString();
  const r = await callServiceAsAdmin('GET', `${inventoryUrl()}/admin/inventory?${qs}`, null, req.admin.email);
  res.status(r.status).json(r.data);
});

router.get('/inventory/out-of-stock', requirePermission('inventory', 'read'), async (req, res) => {
  const r = await callServiceAsAdmin('GET', `${inventoryUrl()}/admin/inventory/out-of-stock`, null, req.admin.email);
  res.status(r.status).json(r.data);
});

router.get('/inventory/dormant', requirePermission('inventory', 'read'), async (req, res) => {
  const r = await callServiceAsAdmin('GET', `${inventoryUrl()}/admin/inventory/dormant-stock`, null, req.admin.email);
  res.status(r.status).json(r.data);
});

// ── Sellers (extended) ────────────────────────────────────────────────────────
router.patch('/sellers/:storeId/tier', requirePermission('sellers', 'tier'), auditLog('seller.tierChange', 'Store'), async (req, res) => {
  const r = await callServiceAsAdmin('PATCH', `${sellerUrl()}/admin/${req.params.storeId}/tier`, req.body, req.admin.email);
  res.status(r.status).json(r.data);
});

router.get('/sellers/dormant', requirePermission('sellers', 'read'), async (req, res) => {
  const r = await callServiceAsAdmin('GET', `${sellerUrl()}/admin/stores/dormant`, null, req.admin.email);
  res.status(r.status).json(r.data);
});

router.get('/sellers/:storeId/profile', requirePermission('sellers', 'read'), async (req, res) => {
  const r = await callServiceAsAdmin('GET', `${sellerUrl()}/admin/stores/${req.params.storeId}/profile`, null, req.admin.email);
  res.status(r.status).json(r.data);
});

// ── Catalog (extended) ────────────────────────────────────────────────────────
router.patch('/catalog/products/:id/force-status', requirePermission('catalog', 'approve'), auditLog('catalog.forceStatus', 'Product'), async (req, res) => {
  const r = await callServiceAsAdmin('PATCH', `${catalogUrl()}/admin/products/${req.params.id}/force-status`, req.body, req.admin.email);
  res.status(r.status).json(r.data);
});

router.delete('/catalog/products/:id/hard-delete', requirePermission('catalog', 'approve'), auditLog('catalog.hardDelete', 'Product'), async (req, res) => {
  const r = await callServiceAsAdmin('DELETE', `${catalogUrl()}/products/${req.params.id}`, req.body, req.admin.email);
  res.status(r.status).json(r.data);
});

router.get('/catalog/products/admin', requirePermission('catalog', 'approve'), async (req, res) => {
  const qs = new URLSearchParams(req.query).toString();
  const r = await callServiceAsAdmin('GET', `${catalogUrl()}/admin/products?${qs}`, null, req.admin.email);
  res.status(r.status).json(r.data);
});

router.get('/catalog/stale', requirePermission('catalog', 'approve'), async (req, res) => {
  const r = await callServiceAsAdmin('GET', `${catalogUrl()}/admin/products/stale`, null, req.admin.email);
  res.status(r.status).json(r.data);
});

// ── Payments (extended) ───────────────────────────────────────────────────────
router.patch('/payments/:orderId/split-refund', requirePermission('payments', 'splitRefund'), auditLog('payment.splitRefund', 'Payment'), async (req, res) => {
  const r = await callServiceAsAdmin('PATCH', `${paymentUrl()}/admin/escrows/${req.params.orderId}/split-refund`, req.body, req.admin.email);
  res.status(r.status).json(r.data);
});

router.patch('/payments/:orderId/extend-dispute', requirePermission('payments', 'freeze'), auditLog('payment.extendDispute', 'Payment'), async (req, res) => {
  const r = await callServiceAsAdmin('PATCH', `${paymentUrl()}/admin/escrows/${req.params.orderId}/extend-dispute-window`, req.body, req.admin.email);
  res.status(r.status).json(r.data);
});

router.post('/payments/hold-payouts/:sellerId', requirePermission('payments', 'payoutHold'), auditLog('payment.payoutHold', 'Seller'), async (req, res) => {
  const r = await callServiceAsAdmin('POST', `${paymentUrl()}/admin/payments/hold-payouts/${req.params.sellerId}`, req.body, req.admin.email);
  res.status(r.status).json(r.data);
});

router.delete('/payments/hold-payouts/:sellerId', requirePermission('payments', 'payoutHold'), auditLog('payment.liftPayoutHold', 'Seller'), async (req, res) => {
  const r = await callServiceAsAdmin('DELETE', `${paymentUrl()}/admin/payments/hold-payouts/${req.params.sellerId}`, null, req.admin.email);
  res.status(r.status).json(r.data);
});

router.get('/payments/payout-holds', requirePermission('payments', 'payoutHold'), async (req, res) => {
  const r = await callServiceAsAdmin('GET', `${paymentUrl()}/admin/payments/payout-holds`, null, req.admin.email);
  res.status(r.status).json(r.data);
});

// ── Search (extended) ─────────────────────────────────────────────────────────
router.get('/search/health', requirePermission('search', 'read'), async (req, res) => {
  const r = await callServiceAsAdmin('GET', `${searchUrl()}/admin/index-health`, null, req.admin.email);
  res.status(r.status).json(r.data);
});

router.post('/search/reindex-all', requirePermission('search', 'reindex'), auditLog('search.reindexAll', 'SearchIndex'), async (req, res) => {
  const r = await callServiceAsAdmin('POST', `${searchUrl()}/admin/reindex-all`, req.body, req.admin.email);
  res.status(r.status).json(r.data);
});

router.patch('/search/products/:id/unhide', requirePermission('search', 'hide'), auditLog('search.unhide', 'Product'), async (req, res) => {
  const r = await callServiceAsAdmin('PATCH', `${searchUrl()}/admin/${req.params.id}/unhide`, null, req.admin.email);
  res.status(r.status).json(r.data);
});

router.post('/search/cache/clear', requirePermission('search', 'reindex'), async (req, res) => {
  const r = await callServiceAsAdmin('POST', `${searchUrl()}/admin/cache/clear`, null, req.admin.email);
  res.status(r.status).json(r.data);
});

router.get('/search/autocomplete', requirePermission('search', 'autocomplete'), async (req, res) => {
  const r = await callServiceAsAdmin('GET', `${searchUrl()}/admin/autocomplete`, null, req.admin.email);
  res.status(r.status).json(r.data);
});

// ── Inventory (additional) ────────────────────────────────────────────────────
router.get('/inventory/reservation-summary', requirePermission('inventory', 'read'), async (req, res) => {
  const r = await callServiceAsAdmin('GET', `${inventoryUrl()}/admin/inventory/reservation-summary`, null, req.admin.email);
  res.status(r.status).json(r.data);
});

// ── Search autocomplete delete ────────────────────────────────────────────────
router.delete('/search/autocomplete/:term', requirePermission('search', 'autocomplete'), auditLog('search.deleteAutocomplete', 'SearchIndex'), async (req, res) => {
  const r = await callServiceAsAdmin('DELETE', `${searchUrl()}/admin/autocomplete/${req.params.term}`, null, req.admin.email);
  res.status(r.status).json(r.data);
});

// ── Notifications resend ──────────────────────────────────────────────────────
router.post('/notifications/resend/:id', requirePermission('notifications', 'send'), auditLog('notification.resend', 'Notification'), async (req, res) => {
  const r = await callServiceAsAdmin('POST', `${notifUrl()}/admin/notifications/${req.params.id}/resend`, null, req.admin.email);
  res.status(r.status).json(r.data);
});

// ── System config (platform fee / dispute window) — proxy to admin-service self ──
// These are handled directly in admin-service /system routes — no proxy needed.

// ── Audit Log ─────────────────────────────────────────────────────────────────
router.get('/audit', requirePermission('audit', 'readAll'), async (req, res) => {
  const qs = new URLSearchParams(req.query).toString();
  // Audit is in admin-service itself
  const r = await callService('GET', `${process.env.ADMIN_SERVICE_URL || 'http://localhost:5013'}/admin/system/audit?${qs}`, null, req.admin.email);
  res.status(r.status).json(r.data);
});

module.exports = router;
