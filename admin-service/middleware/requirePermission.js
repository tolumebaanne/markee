/**
 * requirePermission(domain, action) — permission gate factory.
 *
 * Usage:
 *   router.post('/products/:id/approve', requireAdminAuth, requirePermission('catalog', 'approve'), handler)
 *
 * Superusers bypass all permission checks — they have 101% of all features.
 * Spawned admins are checked against their live DB permissions (already loaded by requireAdminAuth).
 */
const errorResponse = require('../../shared/utils/errorResponse');

module.exports = function requirePermission(domain, action) {
  return function (req, res, next) {
    if (!req.admin) return errorResponse(res, 401, 'Not authenticated as admin');

    // Superuser has all permissions
    if (req.admin.isSuperuser) return next();

    const domainPerms = req.admin.permissions[domain];
    if (!domainPerms || !domainPerms[action]) {
      return errorResponse(res, 403, `Permission denied: ${domain}.${action}`);
    }

    // Apply scope restrictions server-side as forced query/body parameters
    if (req.admin.scopeRestrictions) {
      const { storeId, category } = req.admin.scopeRestrictions;
      if (storeId)  req._scopeStoreId  = storeId.toString();
      if (category) req._scopeCategory = category;
    }

    next();
  };
};
