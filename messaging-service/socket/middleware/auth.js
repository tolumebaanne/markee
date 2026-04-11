const jwt = require('jsonwebtoken');

function socketAuth(socket, next) {
    const token = socket.handshake.auth.token;
    if (!token) return next(new Error('Auth error: no token'));

    const secret = process.env.JWT_SECRET;
    if (!secret) return next(new Error('Auth error: server misconfigured'));

    jwt.verify(token, secret, (err, decoded) => {
        if (err) return next(new Error('Auth error: invalid token'));
        socket.user = decoded;
        next();
    });
}

module.exports = socketAuth;
