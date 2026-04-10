require('dotenv').config({ path: require('path').join(__dirname, '.env') });
const express = require('express');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const { createProxyMiddleware } = require('http-proxy-middleware');
const path = require('path');
const verifyToken = require('../shared/middleware/verifyToken');
const enforceScope = require('../shared/middleware/enforceScope');
const errorResponse = require('../shared/utils/errorResponse');
const platformGuard = require('../shared/middleware/platformGuard');

const app = express();
const PORT = process.env.PORT || 4000;

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(express.static(path.join(__dirname, 'public')));
// app.use(express.urlencoded({ extended: true })); // Moved to targeted routes to prevent proxy body consumption
app.use(cors());
app.use(platformGuard);

const apiLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 1000 });
app.use('/api/', apiLimiter);

// ── Proxy factory helpers ─────────────────────────────────────────────────────
const proxy = (target) => createProxyMiddleware({
    target,
    changeOrigin: true,
    on: { error: (err, req, res) => errorResponse(res, 502, `Service unreachable: ${target}`) }
});

const authProxy = createProxyMiddleware({
    target: process.env.AUTH_SERVICE_URL || 'http://localhost:5001',
    changeOrigin: true,
    pathRewrite: (p) => `/oauth${p}`,
    on: { error: (err, req, res) => errorResponse(res, 502, 'Auth service unreachable') }
});

// ── Auth / OAuth proxies (public) ─────────────────────────────────────────────
app.use('/oauth', authProxy);
app.use('/api/auth', createProxyMiddleware({
    target: process.env.AUTH_SERVICE_URL || 'http://localhost:5001',
    changeOrigin: true,
    pathRewrite: { '^/api/auth': '' },
    on: { error: (err, req, res) => errorResponse(res, 502, 'Auth service unreachable') }
}));

// ── Catalog — GET public, write requires seller scope, admin review routes require admin role ──
// S7 — Admin-only catalog paths:
//   GET  /products/pending-review      — moderation queue
//   POST /products/:id/approve         — approve a product
//   POST /products/:id/reject          — reject with reason
// These are enforced here at the gateway layer. The service enforces again internally.
const CATALOG_URL = process.env.CATALOG_SERVICE_URL || 'http://localhost:5002';
app.use('/api/catalog', (req, res, next) => {
    const isTelemetry = req.method === 'POST' && req.path.endsWith('/telemetry');
    // Admin-only paths — require token + admin role (not seller scope)
    const isAdminReviewPath =
        (req.method === 'GET'  && req.path === '/products/pending-review') ||
        (req.method === 'POST' && /^\/products\/[^/]+\/(approve|reject)$/.test(req.path));
    // Public GETs: any GET except /my-products and the admin review queue
    const isPublicGet = req.method === 'GET' && !req.path.includes('/my-products') && !isAdminReviewPath;

    if (isTelemetry || isPublicGet) return proxy(CATALOG_URL)(req, res, next);

    verifyToken(req, res, () => {
        if (isAdminReviewPath) {
            if (req.user?.role !== 'admin') return errorResponse(res, 403, 'Admin only');
            return proxy(CATALOG_URL)(req, res, next);
        }
        if (req.method !== 'GET') {
            enforceScope('catalog:write')(req, res, () => proxy(CATALOG_URL)(req, res, next));
        } else {
            proxy(CATALOG_URL)(req, res, next);
        }
    });
});

// ── Orders ────────────────────────────────────────────────────────────────────
// S31/S23 — Admin order list: declared before catch-all so /admin path gets role-checked
app.use('/api/orders/admin', verifyToken, (req, res, next) => {
    if (req.user?.role !== 'admin') return errorResponse(res, 403, 'Admin only');
    next();
}, proxy(process.env.ORDER_SERVICE_URL || 'http://localhost:5003'));

app.use('/api/orders', verifyToken, proxy(process.env.ORDER_SERVICE_URL || 'http://localhost:5003'));

// ── Payments ──────────────────────────────────────────────────────────────────
// Admin-only routes must be declared before the general catch-all (S19)
app.use('/api/payments/admin', verifyToken, (req, res, next) => {
    if (req.user?.role !== 'admin') return errorResponse(res, 403, 'Admin only');
    next();
}, proxy(process.env.PAYMENT_SERVICE_URL || 'http://localhost:5004'));

// Buyer payment history — buyer-scoped; no extra gateway enforcement (service enforces sub match)
app.use('/api/payments/my-orders', verifyToken, proxy(process.env.PAYMENT_SERVICE_URL || 'http://localhost:5004'));

// Seller payout history — requires storeId in token (service enforces)
app.use('/api/payments/seller-payouts', verifyToken, proxy(process.env.PAYMENT_SERVICE_URL || 'http://localhost:5004'));

// Catch-all — any authenticated user (service-level auth determines access per route)
app.use('/api/payments', verifyToken, proxy(process.env.PAYMENT_SERVICE_URL || 'http://localhost:5004'));

// ── Seller (public lookup via /api/public-seller, protected write via /api/seller) ──
app.use('/api/public-seller', proxy(process.env.SELLER_SERVICE_URL || 'http://localhost:5005'));

// S31/S26/S30 — Admin seller routes: verify/unverify store, list all stores — before catch-all
app.use('/api/seller/admin', verifyToken, (req, res, next) => {
    if (req.user?.role !== 'admin') return errorResponse(res, 403, 'Admin only');
    next();
}, proxy(process.env.SELLER_SERVICE_URL || 'http://localhost:5005'));

// Seller routes — register and activate skip the scope gate (user has no seller scopes yet);
// everything else requires catalog:write.
app.use('/api/seller', verifyToken, (req, res, next) => {
    const noScopeNeeded =
        (req.method === 'POST' && req.path === '/register') ||
        (req.method === 'POST' && /^\/[^/]+\/activate$/.test(req.path));
    if (noScopeNeeded) return next();
    enforceScope('catalog:write')(req, res, next);
}, proxy(process.env.SELLER_SERVICE_URL || 'http://localhost:5005'));

// ── Inventory ─────────────────────────────────────────────────────────────────
// Public stock availability check — buyers need this for watchlist stock status
app.use('/api/inventory/stock', proxy(process.env.INVENTORY_SERVICE_URL || 'http://localhost:5006'));
// All other inventory routes require seller scope
app.use('/api/inventory', verifyToken, enforceScope('inventory:write'), proxy(process.env.INVENTORY_SERVICE_URL || 'http://localhost:5006'));

// ── Shipping ──────────────────────────────────────────────────────────────────
// Admin route must be declared before the general catch-all (S21)
app.use('/api/shipping/admin', verifyToken, (req, res, next) => {
    if (req.user?.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
    next();
}, proxy(process.env.SHIPPING_SERVICE_URL || 'http://localhost:5007'));

// GET routes (tracking lookup) are buyer-accessible — just need valid token.
// POST (create shipment) and PATCH require shipping:write scope — sellers and admins only.
app.use('/api/shipping', verifyToken, (req, res, next) => {
    if (req.method === 'GET') return next();
    enforceScope('shipping:write')(req, res, next);
}, proxy(process.env.SHIPPING_SERVICE_URL || 'http://localhost:5007'));

// ── Reviews (A.12 — specific routes before catch-all) ────────────────────────
const REVIEW_URL = process.env.REVIEW_SERVICE_URL || 'http://localhost:5008';

// Public seller review routes (no auth required) — MUST be before catch-all
app.use('/api/reviews/seller',        proxy(REVIEW_URL));
app.use('/api/reviews/seller-reviews', proxy(REVIEW_URL));

// Authenticated-only sub-routes
app.use('/api/reviews/my-reviews', verifyToken, proxy(REVIEW_URL));
app.use('/api/reviews/check',      verifyToken, proxy(REVIEW_URL));

// Catch-all: public for GET /product/:id, auth required for everything else
app.use('/api/reviews', (req, res, next) => {
    const isPublicGet = req.method === 'GET' && req.path.startsWith('/product/');
    if (isPublicGet) return proxy(REVIEW_URL)(req, res, next);
    verifyToken(req, res, () => proxy(REVIEW_URL)(req, res, next));
});

// ── Messaging ─────────────────────────────────────────────────────────────────
const MESSAGING_URL = process.env.MESSAGING_SERVICE_URL || 'http://localhost:5009';

const msgProxy = createProxyMiddleware({
    target: MESSAGING_URL,
    changeOrigin: true,
    on: { error: (_err, _req, res) => errorResponse(res, 502, 'Messaging service unreachable') }
});

// Socket.io WebSocket proxy — browser connects to /socket.io on the gateway;
// we forward the full path back to the messaging service.
const socketProxy = createProxyMiddleware({
    target: MESSAGING_URL,
    changeOrigin: true,
    ws: true,
    pathRewrite: (path) => `/socket.io${path}`
});
app.use('/socket.io', socketProxy);

// All messaging routes under /api/messages — single handler so Express strips only
// the /api/messages prefix, leaving /thread/:id, /threads, /uploads etc. intact.
// Uploads are public; admin-only thread inspection checked inline.
app.use('/api/messages', (req, res, next) => {
    // /uploads is public — no auth required
    if (req.path.startsWith('/uploads')) return msgProxy(req, res, next);
    // All other messaging routes require a valid token
    verifyToken(req, res, () => {
        // /thread/:id/admin requires admin role
        if (/\/thread\/[^/]+\/admin$/.test(req.path) && req.user?.role !== 'admin') {
            return errorResponse(res, 403, 'Admin only');
        }
        msgProxy(req, res, next);
    });
});

// ── Notifications ─────────────────────────────────────────────────────────────
app.use('/api/notifications', verifyToken, proxy(process.env.NOTIFICATION_SERVICE_URL || 'http://localhost:5010'));

// ── Analytics ─────────────────────────────────────────────────────────────────
// Requires analytics:read (sellers) or analytics:* (admins). Buyers have neither.
app.use('/api/analytics', verifyToken, enforceScope('analytics:read'), proxy(process.env.ANALYTICS_SERVICE_URL || 'http://localhost:5011'));

// ── Search (public) ───────────────────────────────────────────────────────────
app.use('/api/search', proxy(process.env.SEARCH_SERVICE_URL || 'http://localhost:5012'));

// ── User profiles (JWT required, users manage own data) ───────────────────────

const userProxy = createProxyMiddleware({
    target: process.env.USER_SERVICE_URL || 'http://localhost:5013',
    changeOrigin: true,
    pathRewrite: { '^/api/users': '/users' },
    on: { error: (err, req, res) => errorResponse(res, 502, 'User service unreachable') }
});

app.use('/api/users/watching-store', verifyToken, (req, res, next) => {
    if (req.user?.role !== 'admin') return errorResponse(res, 403, 'Admin scope required');
    next();
}, userProxy);

app.use('/api/users/watching', verifyToken, (req, res, next) => {
    if (req.user?.role !== 'admin') return errorResponse(res, 403, 'Admin scope required');
    next();
}, userProxy);

app.use('/api/users', verifyToken, userProxy);

// ── Admin Service ─────────────────────────────────────────────────────────────
// No verifyToken at gateway — admin service does its own JWT validation
// with DB-authoritative permission checks on every request.
app.use('/api/admin', proxy(process.env.ADMIN_SERVICE_URL || 'http://localhost:5014'));

// ── Frontend pages ────────────────────────────────────────────────────────────
app.get('/',            (req, res) => res.render('index'));
app.get('/login',       (req, res) => res.render('login',    {
    gatewayUrl: process.env.GATEWAY_URL || `http://localhost:${process.env.PORT || 4000}`
}));
app.get('/register',  (_req, res) => res.render('register', {}));
app.post('/register', express.urlencoded({ extended: true }), async (req, res) => {
    const AUTH = process.env.AUTH_SERVICE_URL || 'http://localhost:5001';
    try {
        const body = new URLSearchParams(req.body).toString();
        const r = await fetch(`${AUTH}/register`, {
            method:   'POST',
            headers:  { 'Content-Type': 'application/x-www-form-urlencoded' },
            body,
            redirect: 'manual'   // intercept the redirect instead of following it
        });
        const location = r.headers.get('location') || '';
        // Auth-service redirects to /login on success, /register?error=... on failure
        if (location.includes('/login')) {
            return res.redirect('/login?success=Registration successful! Please sign in.');
        }
        // Parse error param from redirect URL
        const errParam = location.includes('error=')
            ? decodeURIComponent(location.split('error=')[1] || '')
            : 'Registration failed. Please try again.';
        return res.render('register', { error: errParam });
    } catch (err) {
        console.error('[GATEWAY] /register proxy error:', err.message);
        res.render('register', { error: 'Registration service is currently unavailable.' });
    }
});
app.get('/dashboard',   (req, res) => res.render('dashboard'));
app.get('/inventory',   (req, res) => res.render('inventory'));
app.get('/messages',    (_req, res) => res.render('messages', {}));
app.get('/checkout',    (req, res) => res.render('checkout'));
app.get('/cart',        (req, res) => res.render('cart'));
app.get('/product/:id',    (req, res) => res.render('product',    { productId: req.params.id }));
app.get('/store/:storeId', (req, res) => res.render('storefront', { storeId: req.params.storeId }));
app.get('/profile',        (req, res) => res.render('profile'));
app.get('/orders',      (req, res) => res.render('orders'));
app.get('/orders/:id',  (req, res) => res.render('order-detail', { orderId: req.params.id }));
app.get('/admin',         (req, res) => res.render('admin'));
app.get('/admin-login',   (req, res) => res.render('admin-login', {
    adminServiceUrl: process.env.ADMIN_SERVICE_URL || 'http://localhost:5014'
}));
app.get('/admin/accounts',   (req, res) => res.render('admin-accounts'));
app.get('/admin/templates',  (req, res) => res.render('admin-templates'));
app.get('/admin/system',     (req, res) => res.render('admin-system'));
app.get('/admin/intelligence',(req, res) => res.render('admin-intelligence'));

// ── OAuth callback ────────────────────────────────────────────────────────────
app.get('/callback', async (req, res) => {
    const { code, error, state } = req.query;

    // Extract the ?next= URL from the OAuth state param (set by login.ejs)
    let nextUrl = '/dashboard';
    try {
        const stateData = JSON.parse(decodeURIComponent(state || '{}'));
        // Only accept relative paths that start with / but not // (open redirect guard)
        if (stateData.next && /^\/[^/]/.test(stateData.next) && stateData.next.length < 200) {
            nextUrl = stateData.next;
        }
    } catch { /* malformed state — use default */ }
    if (error) return res.send(`Access Denied: ${error}`);
    if (!code) return res.redirect('/login');

    try {
        const tokenRes = await fetch(`${process.env.AUTH_SERVICE_URL || 'http://localhost:5001'}/oauth/token`, {
            method:  'POST',
            headers: { 'Content-Type': 'application/json' },
            body:    JSON.stringify({
                grant_type:   'authorization_code',
                code,
                client_id:    'markee-gateway',
                redirect_uri: `${process.env.GATEWAY_URL || `http://localhost:${process.env.PORT || 4000}`}/callback`
            })
        });
        const data = await tokenRes.json();
        if (data.error) {
            console.error('[GATEWAY] Token exchange error:', data);
            return res.send(`OAuth Error: ${data.error}`);
        }

        res.send(`
            <script src="/js/cart.js"></script>
            <script>
                localStorage.setItem('access_token', '${data.access_token}');
                localStorage.setItem('refresh_token', '${data.refresh_token}');
                // Fold any guest cart items into the now-identified user cart
                if (window.MarkeeCart) MarkeeCart.migrateGuestCart();
                const role = JSON.parse(atob('${data.access_token}'.split('.')[1])).role;
                // Redirect admin to /admin; regular users go to ?next= or /dashboard
                window.location.replace(role === 'admin' ? '/admin' : ${JSON.stringify(nextUrl)});
            </script>
        `);
    } catch (err) {
        console.error('[GATEWAY] Callback error:', err);
        res.send('Gateway Integration Error: ' + err.message);
    }
});

// ── Global error handler ──────────────────────────────────────────────────────
app.use((err, req, res, next) => {
    console.error('[GATEWAY] Unhandled error:', err.message);
    errorResponse(res, 500, err.message || 'Gateway Internal Error');
});

app.get('/health', (req, res) => {
    res.json({ service: 'api-gateway', status: 'ok' });
});

const server = app.listen(PORT, () => console.log(`API Gateway on port ${PORT}`));
// WebSocket upgrade forwarding for Socket.io (messaging service)
server.on('upgrade', socketProxy.upgrade);
