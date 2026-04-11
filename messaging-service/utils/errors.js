class AppError extends Error {
    constructor(message, statusCode) {
        super(message);
        this.statusCode = statusCode;
        this.name = 'AppError';
    }
}

class NotFoundError extends AppError {
    constructor(message = 'Not found') {
        super(message, 404);
        this.name = 'NotFoundError';
    }
}

class ForbiddenError extends AppError {
    constructor(message = 'Forbidden') {
        super(message, 403);
        this.name = 'ForbiddenError';
    }
}

class ValidationError extends AppError {
    constructor(message = 'Validation failed') {
        super(message, 422);
        this.name = 'ValidationError';
    }
}

module.exports = { AppError, NotFoundError, ForbiddenError, ValidationError };
