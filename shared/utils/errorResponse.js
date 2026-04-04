module.exports = (res, statusCode, message, overrideCode = null) => {
    res.status(statusCode).json({
        error: true,
        code: overrideCode || statusCode,
        message
    });
};
