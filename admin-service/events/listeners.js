/**
 * Admin Service Event Listeners
 *
 * The Admin Service listens to platform events to maintain cross-service
 * intelligence state and respond to security-relevant events.
 */
const bus = require('../../shared/eventBus');

function registerListeners() {
  // ── Admin auth events ────────────────────────────────────────────────────────
  bus.on('admin.login', (payload) => {
    console.log(`[ADMIN] Login: ${payload.email} (${payload.isSuperuser ? 'Superuser' : 'Admin'}) from ${payload.ip}`);
  });

  bus.on('admin.logout', (payload) => {
    console.log(`[ADMIN] Logout: adminId=${payload.adminId} session=${payload.sessionId}`);
  });

  bus.on('admin.recovery_code_used', (payload) => {
    console.warn(`[ADMIN] ⚠️  Recovery code used by adminId=${payload.adminId}. Codes remaining: ${payload.codesRemaining}`);
    if (payload.codesRemaining === 0) {
      console.warn(`[ADMIN] ⚠️  No recovery codes remaining for adminId=${payload.adminId} — user must regenerate.`);
    }
  });

  bus.on('admin.account_suspended', (payload) => {
    console.log(`[ADMIN] Account suspended: ${payload.targetAdminId} by ${payload.suspendedBy}`);
  });

  bus.on('admin.impersonation_started', (payload) => {
    console.warn(`[ADMIN] 🔍 Impersonation: adminId=${payload.adminId} → userId=${payload.targetUserId}. Reason: ${payload.reason}`);
  });

  bus.on('admin.tokens_nuked', (payload) => {
    console.warn(`[ADMIN] 💥 Tokens nuked for userId=${payload.userId} by adminId=${payload.nukedBy}. Reason: ${payload.reason}`);
  });

  // ── Platform state events ────────────────────────────────────────────────────
  bus.on('platform.maintenance_mode', (payload) => {
    console.log(`[ADMIN] Platform maintenance mode: ${payload.enabled ? 'ON' : 'OFF'}. Reason: ${payload.reason}`);
  });

  bus.on('platform.lockdown', (payload) => {
    console.warn(`[ADMIN] ⛔ Platform lockdown: ${payload.enabled ? 'ACTIVATED' : 'DEACTIVATED'}. Reason: ${payload.reason}`);
  });

  bus.on('platform.flags_updated', (payload) => {
    console.log(`[ADMIN] Feature flags updated by adminId=${payload.updatedBy}:`, payload.flags);
  });

  // ── Cross-service intelligence events ────────────────────────────────────────
  // Listen for seller deactivation to flag for review
  bus.on('seller.deactivated', (payload) => {
    console.log(`[ADMIN][INTEL] Seller deactivated: storeId=${payload.storeId}`);
  });

  // Listen for high-volume refunds
  bus.on('payment.refunded', (payload) => {
    if (payload.amountCents > 10000) { // > $100 refund
      console.warn(`[ADMIN][INTEL] Large refund: $${(payload.amountCents / 100).toFixed(2)} for orderId=${payload.orderId}`);
    }
  });

  // Listen for store verification events (actual admin verification)
  bus.on('store.verified', (payload) => {
    console.log(`[ADMIN][INTEL] Store verified: storeId=${payload.storeId} (${payload.storeName})`);
  });

  // Listen for cache sync events (startup warming — not a real verification)
  bus.on('store.cache_sync', (payload) => {
    console.log(`[ADMIN][INTEL] Store cache sync: storeId=${payload.storeId} (${payload.storeName})`);
  });

  console.log('[ADMIN] Event listeners registered');
}

module.exports = { registerListeners };
