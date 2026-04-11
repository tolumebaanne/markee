const errorResponse = require('../../shared/utils/errorResponse');

function requireAuth(req, res, next) {
    if (!req.user || !req.user.sub) {
        return errorResponse(res, 401, 'Unauthorized');
    }
    next();
}

module.exports = requireAuth;
