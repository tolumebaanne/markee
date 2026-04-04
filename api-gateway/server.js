require('dotenv').config();
const express = require('express');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const { createProxyMiddleware } = require('http-proxy-middleware');
const path = require('path');
const verifyToken = require('../shared/middleware/verifyToken');
const enforceScope = require('../shared/middleware/enforceScope');
const errorResponse = require('../shared/utils/errorResponse');

const app = express();
const PORT = process.env.PORT || 4000;

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(express.static(path.join(__dirname, 'public')));
app.use(cors());

const apiLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 100 });
app.use('/api/', apiLimiter);

// Standard Error formatting for failed proxies
const proxyOptions = (target) => ({
    target, 
    changeOrigin: true,
    onError: (err, req, res) => errorResponse(res, 502, `Service unreachable: ${target}`)
});

// Proxy definitions
app.use('/oauth', createProxyMiddleware(proxyOptions(process.env.AUTH_SERVICE_URL || 'http://localhost:5001')));

app.use('/api/catalog', (req, res, next) => {
    if (req.method === 'GET') {
        return createProxyMiddleware(proxyOptions(process.env.CATALOG_SERVICE_URL || 'http://localhost:5002'))(req, res, next);
    }
    verifyToken(req, res, () => {
        enforceScope('catalog:write')(req, res, () => {
            createProxyMiddleware(proxyOptions(process.env.CATALOG_SERVICE_URL || 'http://localhost:5002'))(req, res, next);
        });
    });
});

app.use('/api/seller', verifyToken, enforceScope('seller:*'), createProxyMiddleware(proxyOptions(process.env.SELLER_SERVICE_URL || 'http://localhost:5005')));
app.use('/api/inventory', verifyToken, enforceScope('inventory:write'), createProxyMiddleware(proxyOptions(process.env.INVENTORY_SERVICE_URL || 'http://localhost:5006')));

// Frontend Page Routes 
app.get('/', (req, res) => res.render('index'));
app.get('/login', (req, res) => res.render('login'));
app.get('/register', (req, res) => res.render('register'));
app.get('/dashboard', (req, res) => res.render('dashboard'));

app.use((err, req, res, next) => {
    console.error(err);
    errorResponse(res, 500, err.message || 'Gateway Internal Error');
});

app.listen(PORT, () => console.log(`API Gateway on port ${PORT}`));
