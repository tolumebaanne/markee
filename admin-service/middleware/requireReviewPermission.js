/**
 * requireReviewPermission(flag) — gate factory for listing review actions.
 *
 * Checks req.admin.permissions.listingReview[flag].
 * Superusers bypass all checks.
 *
 * Flags:
 *   canReview             — see queue, approve, disapprove, reject
 *   canAssign             — assign/reassign/pullback (Super-level)
 *   canUseTemplates       — create and use review comment templates
 *   canViewOwnActivityLog — view own assignment/review history
 *
 * Usage:
 *   router.post('/templates', requireAdminAuth, requireReviewPermission('canUseTemplates'), handler)
 */
const errorResponse = require('../../shared/utils/errorResponse');

module.exports = function requireReviewPermission(flag) {
  return function (req, res, next) {
    if (!req.admin) return errorResponse(res, 401, 'Not authenticated as admin');

    if (req.admin.isSuperuser) return next();

    const lrPerms = req.admin.permissions?.listingReview;
    if (!lrPerms || !lrPerms[flag]) {
      return errorResponse(res, 403, `Permission denied: listingReview.${flag}`);
    }

    next();
  };
};
