/**
 * start-monolith.js
 *
 * Starts all 13 Markee microservices in a SINGLE Node.js process.
 * This is the correct way to run them during development because:
 *   - All services share the same require('../shared/eventBus') singleton
 *   - Events emitted in one service are received by listeners in every other service
 *   - Each service still listens on its own port (no conflicts)
 *
 * Start with:  node start-monolith.js
 */

const path = require('path');
const fs   = require('fs');

// Prevent a single unhandled async error (e.g. a notification bus listener throwing)
// from crashing the entire 13-service monolith. Log it and keep running.
process.on('unhandledRejection', (reason) => {
    console.error('[MONOLITH] Unhandled promise rejection — process kept alive:', reason?.message || reason);
});
process.on('uncaughtException', (err) => {
    console.error('[MONOLITH] Uncaught exception — process kept alive:', err.message);
});

/**
 * Load a service's .env file with override: true so each service gets
 * its own correct MONGODB_URI, PORT, and any other service-specific vars —
 * even though all services share one process.env in monolith mode.
 */
function loadEnv(serviceDir) {
    const envPath = path.join(__dirname, serviceDir, '.env');
    if (!fs.existsSync(envPath)) return;
    const lines = fs.readFileSync(envPath, 'utf8').split('\n');
    for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;
        const eqIdx = trimmed.indexOf('=');
        if (eqIdx === -1) continue;
        const key = trimmed.slice(0, eqIdx).trim();
        const val = trimmed.slice(eqIdx + 1).trim();
        process.env[key] = val;   // always override
    }
}

/** Extract just the host portion of a MongoDB URI for safe diagnostic logging. */
function mongoHost(uri) {
    if (!uri) return '(not set)';
    try {
        // Strip credentials: mongodb[+srv]://user:pass@host/db → host/db
        const noScheme = uri.replace(/^mongodb(\+srv)?:\/\//, '');
        const atIdx = noScheme.indexOf('@');
        const hostPart = atIdx >= 0 ? noScheme.slice(atIdx + 1) : noScheme;
        // Drop trailing /database?options
        return hostPart.split('?')[0] || '(parse error)';
    } catch { return '(parse error)'; }
}

console.log('=== Markee Monolith Starting ===');
console.log('All services share one EventBus — event chains will work correctly.\n');

// Auth service uses the global mongoose connection — must be required first
loadEnv('auth-service');
console.log(`[ENV] auth-service        → DB host: ${mongoHost(process.env.MONGODB_URI)}`);
require('./auth-service/server');

// All other services use mongoose.createConnection() — each gets its own
// MONGODB_URI and PORT injected via loadEnv() before the require().
loadEnv('catalog-service');      console.log(`[ENV] catalog-service      → DB host: ${mongoHost(process.env.MONGODB_URI)}`); require('./catalog-service/app');
loadEnv('order-service');        console.log(`[ENV] order-service        → DB host: ${mongoHost(process.env.MONGODB_URI)}`); require('./order-service/app');
loadEnv('payment-service');      console.log(`[ENV] payment-service      → DB host: ${mongoHost(process.env.MONGODB_URI)}`); require('./payment-service/app');
loadEnv('seller-service');       console.log(`[ENV] seller-service       → DB host: ${mongoHost(process.env.MONGODB_URI)}`); require('./seller-service/app');
loadEnv('inventory-service');    console.log(`[ENV] inventory-service    → DB host: ${mongoHost(process.env.MONGODB_URI)}`); require('./inventory-service/app');
loadEnv('shipping-service');     console.log(`[ENV] shipping-service     → DB host: ${mongoHost(process.env.MONGODB_URI)}`); require('./shipping-service/app');
loadEnv('review-service');       console.log(`[ENV] review-service       → DB host: ${mongoHost(process.env.MONGODB_URI)}`); require('./review-service/app');
loadEnv('messaging-service');    console.log(`[ENV] messaging-service    → DB host: ${mongoHost(process.env.MONGODB_URI)}`); require('./messaging-service/app');
loadEnv('notification-service'); console.log(`[ENV] notification-service → DB host: ${mongoHost(process.env.MONGODB_URI)}`); require('./notification-service/app');
loadEnv('analytics-service');    console.log(`[ENV] analytics-service    → DB host: ${mongoHost(process.env.MONGODB_URI)}`); require('./analytics-service/app');
loadEnv('search-service');       console.log(`[ENV] search-service       → DB host: ${mongoHost(process.env.MONGODB_URI)}`); require('./search-service/app');
loadEnv('user-service');         console.log(`[ENV] user-service         → DB host: ${mongoHost(process.env.MONGODB_URI)}`); require('./user-service/app');
loadEnv('admin-service');        console.log(`[ENV] admin-service        → DB host: ${mongoHost(process.env.MONGODB_URI)}`); require('./admin-service/app');

// Gateway last — it serves the frontend and proxies to all running services
loadEnv('api-gateway');
require('./api-gateway/server');

console.log('\n=== All services registered. Waiting for DB connections... ===');
console.log('Access the app at: http://localhost:4000\n');
