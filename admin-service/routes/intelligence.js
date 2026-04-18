/**
 * Cross-Service Intelligence — /admin/intelligence/*
 *
 * Aggregated insights that span multiple services:
 * Seller Health Scores, Buyer Risk Scores, Fraud Signals,
 * Marketplace Balance, Onboarding Funnel, Revenue Leakage,
 * Anomaly Detection, Order Timeline Intelligence.
 *
 * Reads live data from downstream services via REST — never queries
 * their databases directly. (m0t.OPERATOR.1.3 / Service Communication Principle)
 */
const express = require('express');
const router  = express.Router();

const requireAdminAuth  = require('../middleware/requireAdminAuth');
const requirePermission = require('../middleware/requirePermission');
const sessionActivity   = require('../middleware/sessionActivity');
const errorResponse     = require('../../shared/utils/errorResponse');

router.use(requireAdminAuth, sessionActivity);

// ── Service fetch helper ──────────────────────────────────────────────────────
// extraHeaders: optional object merged into the request headers.
// All calls to admin-guarded endpoints must pass { 'x-admin-email': adminEmail }
// so downstream services accept the request (they check x-admin-email OR req.user.role=admin).
async function fetchService(url, timeout = 5000, extraHeaders = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { 'Content-Type': 'application/json', ...extraHeaders }
    });
    clearTimeout(timer);
    if (!res.ok) return { error: `Service returned ${res.status}` };
    return await res.json();
  } catch (err) {
    clearTimeout(timer);
    return { error: err.message || 'Service unreachable' };
  }
}

// ── GET /admin/intelligence/seller-health/:storeId ────────────────────────────
router.get('/seller-health/:storeId', requirePermission('intelligence', 'sellerScores'), async (req, res) => {
  try {
    const sellerUrl   = process.env.SELLER_SERVICE_URL   || 'http://localhost:5005';
    const analyticsUrl= process.env.ANALYTICS_SERVICE_URL|| 'http://localhost:5011';
    const reviewUrl   = process.env.REVIEW_SERVICE_URL   || 'http://localhost:5008';

    const [store, analytics, reviews] = await Promise.all([
      fetchService(`${sellerUrl}/${req.params.storeId}`),
      fetchService(`${analyticsUrl}/admin/store/${req.params.storeId}`),
      fetchService(`${reviewUrl}/seller/${req.params.storeId}?limit=5`)
    ]);

    if (store.error) return errorResponse(res, 404, 'Store not found');

    // Compute composite health score (0–100)
    let score = 50;
    if (store.verified)                              score += 10;
    if (store.sellerAvgRating >= 4.5)               score += 15;
    else if (store.sellerAvgRating >= 4.0)          score += 10;
    else if (store.sellerAvgRating < 3.0)           score -= 15;
    if (store.publicStats?.onTimeDeliveryRate > 0.9)score += 10;
    if (store.replyRate > 0.8)                      score += 5;
    if (store.vacationMode?.active)                 score -= 5;
    if (store.tier === 'top')                        score += 10;
    else if (store.tier === 'rising')                score += 5;
    score = Math.min(100, Math.max(0, score));

    res.json({
      storeId:    req.params.storeId,
      storeName:  store.name,
      healthScore: score,
      tier:        store.tier,
      verified:    store.verified,
      avgRating:   store.sellerAvgRating,
      replyRate:   store.replyRate,
      onTimeDeliveryRate: store.publicStats?.onTimeDeliveryRate,
      totalSales:  store.totalSales,
      analytics:   analytics.error ? null : analytics,
      recentReviews: reviews.error ? [] : (reviews.reviews || reviews).slice(0, 5)
    });
  } catch (err) {
    errorResponse(res, 500, err.message);
  }
});

// ── GET /admin/intelligence/marketplace-balance ───────────────────────────────
router.get('/marketplace-balance', requirePermission('intelligence', 'balance'), async (req, res) => {
  try {
    const sellerUrl  = process.env.SELLER_SERVICE_URL    || 'http://localhost:5005';
    const catalogUrl = process.env.CATALOG_SERVICE_URL   || 'http://localhost:5002';
    const orderUrl   = process.env.ORDER_SERVICE_URL     || 'http://localhost:5003';
    const paymentUrl = process.env.PAYMENT_SERVICE_URL   || 'http://localhost:5004';
    const adminHdr   = { 'x-admin-email': req.admin.email };

    const [stores, orders, payments] = await Promise.all([
      fetchService(`${sellerUrl}/admin/stores?limit=100`, 5000, adminHdr),
      fetchService(`${orderUrl}/admin/orders?limit=1`, 5000, adminHdr),
      fetchService(`${paymentUrl}/admin/summary`, 5000, adminHdr)
    ]);

    const storeList = stores.stores || [];
    const tierDist  = { standard: 0, rising: 0, top: 0 };
    const verifiedCount = storeList.filter(s => s.verified).length;
    for (const s of storeList) if (s.tier) tierDist[s.tier] = (tierDist[s.tier] || 0) + 1;

    res.json({
      totalActiveStores: stores.total || storeList.length,
      verifiedStores:    verifiedCount,
      tierDistribution:  tierDist,
      totalOrders:       orders.total || null,
      paymentSummary:    payments.error ? null : payments
    });
  } catch (err) {
    errorResponse(res, 500, err.message);
  }
});

// ── GET /admin/intelligence/onboarding-funnel ─────────────────────────────────
router.get('/onboarding-funnel', requirePermission('intelligence', 'funnel'), async (req, res) => {
  try {
    const sellerUrl = process.env.SELLER_SERVICE_URL || 'http://localhost:5005';
    const adminHdr  = { 'x-admin-email': req.admin.email };
    const { stores } = await fetchService(`${sellerUrl}/admin/stores?limit=500`, 5000, adminHdr);
    const list = stores || [];

    const funnel = {
      total:               list.length,
      profilePhotoSet:     list.filter(s => s.setupChecklist?.profilePhoto).length,
      descriptionWritten:  list.filter(s => s.setupChecklist?.descriptionWritten).length,
      firstProductListed:  list.filter(s => s.setupChecklist?.firstProductListed).length,
      firstSaleMade:       list.filter(s => s.setupChecklist?.firstSaleMade).length,
      returnPolicySet:     list.filter(s => s.setupChecklist?.returnPolicySet).length,
      fullyOnboarded:      list.filter(s =>
        s.setupChecklist?.profilePhoto &&
        s.setupChecklist?.descriptionWritten &&
        s.setupChecklist?.firstProductListed &&
        s.setupChecklist?.firstSaleMade &&
        s.setupChecklist?.returnPolicySet
      ).length
    };

    // Compute drop-off percentages
    if (funnel.total > 0) {
      for (const key of Object.keys(funnel)) {
        if (key !== 'total') funnel[`${key}Pct`] = Math.round((funnel[key] / funnel.total) * 100);
      }
    }

    res.json(funnel);
  } catch (err) {
    errorResponse(res, 500, err.message);
  }
});

// ── GET /admin/intelligence/order-timeline/:orderId ───────────────────────────
router.get('/order-timeline/:orderId', requirePermission('orders', 'read'), async (req, res) => {
  try {
    const orderUrl   = process.env.ORDER_SERVICE_URL   || 'http://localhost:5003';
    const paymentUrl = process.env.PAYMENT_SERVICE_URL || 'http://localhost:5004';
    const shipUrl    = process.env.SHIPPING_SERVICE_URL|| 'http://localhost:5007';

    const [order, payment, shipment] = await Promise.all([
      fetchService(`${orderUrl}/admin/orders/${req.params.orderId}`),
      fetchService(`${paymentUrl}/admin/order/${req.params.orderId}`),
      fetchService(`${shipUrl}/admin/order/${req.params.orderId}`)
    ]);

    if (order.error) return errorResponse(res, 404, 'Order not found');

    res.json({
      orderId:  req.params.orderId,
      order:    order,
      payment:  payment.error ? null : payment,
      shipment: shipment.error ? null : shipment,
      timeline: [
        order.createdAt    && { event: 'order.placed',    at: order.createdAt },
        payment?.capturedAt && { event: 'payment.captured', at: payment.capturedAt },
        shipment?.createdAt && { event: 'shipment.created', at: shipment.createdAt },
        shipment?.deliveredAt && { event: 'order.delivered', at: shipment.deliveredAt }
      ].filter(Boolean).sort((a, b) => new Date(a.at) - new Date(b.at))
    });
  } catch (err) {
    errorResponse(res, 500, err.message);
  }
});

// ── GET /admin/intelligence/fraud-signals ─────────────────────────────────────
router.get('/fraud-signals', requirePermission('intelligence', 'fraudSignals'), async (req, res) => {
  try {
    const orderUrl   = process.env.ORDER_SERVICE_URL   || 'http://localhost:5003';
    const paymentUrl = process.env.PAYMENT_SERVICE_URL || 'http://localhost:5004';
    const adminHdr   = { 'x-admin-email': req.admin.email };

    const [recentOrders, refundData] = await Promise.all([
      fetchService(`${orderUrl}/admin/orders?limit=200`, 5000, adminHdr),
      // /admin/refunds does not exist — use /admin/escrows?status=refunded (same data, same service)
      fetchService(`${paymentUrl}/admin/escrows?status=refunded&limit=100`, 5000, adminHdr)
    ]);

    const orders  = recentOrders.orders || [];
    const refunds = refundData.escrows  || [];

    // Basic heuristic fraud signals
    const signals = [];

    // High refund rate
    const refundRate = orders.length > 0 ? refunds.length / orders.length : 0;
    if (refundRate > 0.1) {
      signals.push({ type: 'HIGH_REFUND_RATE', value: Math.round(refundRate * 100) + '%', severity: refundRate > 0.2 ? 'high' : 'medium' });
    }

    // Repeated small orders from same buyer (split order detection)
    const buyerOrderCount = {};
    for (const o of orders) {
      if (o.buyerId) buyerOrderCount[o.buyerId] = (buyerOrderCount[o.buyerId] || 0) + 1;
    }
    const highFreqBuyers = Object.entries(buyerOrderCount).filter(([, c]) => c > 5);
    if (highFreqBuyers.length > 0) {
      signals.push({ type: 'HIGH_FREQUENCY_BUYERS', count: highFreqBuyers.length, severity: 'low' });
    }

    res.json({ signals, ordersScanned: orders.length, refundsScanned: refunds.length, generatedAt: new Date() });
  } catch (err) {
    errorResponse(res, 500, err.message);
  }
});

// ── GET /admin/intelligence/anomalies ─────────────────────────────────────────
router.get('/anomalies', requirePermission('intelligence', 'anomalies'), async (req, res) => {
  try {
    const analyticsUrl = process.env.ANALYTICS_SERVICE_URL || 'http://localhost:5011';
    const data = await fetchService(`${analyticsUrl}/admin/anomalies`);
    if (data.error) return res.json({ anomalies: [], message: 'Analytics service did not return anomaly data' });
    res.json(data);
  } catch (err) {
    errorResponse(res, 500, err.message);
  }
});

// ── GET /admin/intelligence/revenue-leakage ───────────────────────────────────
router.get('/revenue-leakage', requirePermission('intelligence', 'leakage'), async (req, res) => {
  try {
    const paymentUrl = process.env.PAYMENT_SERVICE_URL || 'http://localhost:5004';
    const orderUrl   = process.env.ORDER_SERVICE_URL   || 'http://localhost:5003';

    const [pendingPayments, cancelledOrders] = await Promise.all([
      fetchService(`${paymentUrl}/admin/pending?limit=100`),
      fetchService(`${orderUrl}/admin/orders?status=cancelled&limit=100`)
    ]);

    const pending    = pendingPayments.payments || pendingPayments || [];
    const cancelled  = cancelledOrders.orders   || [];
    const totalPending   = Array.isArray(pending)   ? pending.reduce((s, p)  => s + (p.amountCents || 0), 0) : 0;
    const totalCancelled = Array.isArray(cancelled) ? cancelled.reduce((s, o) => s + (o.totalCents  || 0), 0) : 0;

    res.json({
      pendingPaymentsCount:  Array.isArray(pending)   ? pending.length   : 0,
      pendingAmountCents:    totalPending,
      pendingAmountFormatted:`$${(totalPending / 100).toFixed(2)}`,
      cancelledOrdersCount:  Array.isArray(cancelled) ? cancelled.length : 0,
      cancelledValueCents:   totalCancelled,
      cancelledValueFormatted:`$${(totalCancelled / 100).toFixed(2)}`,
      generatedAt: new Date()
    });
  } catch (err) {
    errorResponse(res, 500, err.message);
  }
});

module.exports = router;
