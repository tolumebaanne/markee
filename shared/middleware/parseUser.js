/**
 * parseUser — canonical x-user header parser
 * Applied to every service that needs req.user.
 * The API Gateway's verifyToken middleware sets this header as JSON.stringify(decodedJwt).
 * Import this from shared/, never copy-paste it into a service.
 */
module.exports = (req, res, next) => {
    const raw = req.headers['x-user'];
    if (raw) {
        try {
            req.user = JSON.parse(raw);
        } catch {
            // Malformed header — treat as unauthenticated, let the route guard handle it
            req.user = null;
        }
    } else {
        req.user = null;
    }
    next();
};
