const { validationResult } = require('express-validator');

module.exports = function handleValidationErrors(req, res, next) {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
        const fields = {};
        errors.array().forEach(e => { fields[e.path || e.param] = e.msg; });
        return res.status(422).json({
            error:   true,
            code:    'VALIDATION_ERROR',
            message: 'Validation failed',
            fields
        });
    }
    next();
};
