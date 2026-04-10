const jwt = require('jsonwebtoken');
const errorResponse = require('../utils/errorResponse');

module.exports = (req, res, next) => {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return errorResponse(res, 401, 'Missing or invalid authorization header');
    }

    const token = authHeader.split(' ')[1];
    try {
        const decoded = jwt.verify(token, process.env.JWT_SECRET);
        req.user = decoded; // gateway middleware use
        // Forward decoded payload to downstream microservices as a header
        req.headers['x-user'] = JSON.stringify(decoded);
        next();
    } catch (err) {
        return errorResponse(res, 401, 'Token invalid or expired');
    }
};
