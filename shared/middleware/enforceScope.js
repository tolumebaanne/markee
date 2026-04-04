const errorResponse = require('../utils/errorResponse');

module.exports = (requiredScopes) => {
    return (req, res, next) => {
        if (!req.user || !req.user.scopes) {
            return errorResponse(res, 403, 'No scopes found in token');
        }
        
        const scopesArray = Array.isArray(requiredScopes) ? requiredScopes : [requiredScopes];
        
        const hasAllRequired = scopesArray.every(reqScope => {
            return req.user.scopes.some(userScope => {
                if (userScope === reqScope) return true;
                const [reqDomain] = reqScope.split(':');
                const [userDomain, userAction] = userScope.split(':');
                return userDomain === reqDomain && userAction === '*';
            });
        });

        if (!hasAllRequired) {
            return errorResponse(res, 403, `Insufficient scope. Requires ${scopesArray.join(', ')}`);
        }
        next();
    };
};
