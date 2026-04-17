const errorResponse = require('../../shared/utils/errorResponse');

function requireAdmin(req, res, next) {
    if (!req.headers['x-admin-email'] && req.user?.role !== 'admin') {
        return errorResponse(res, 403, 'Admin only');
    }
    next();
}

module.exports = requireAdmin;
