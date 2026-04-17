/**
 * platformGuard.js
 * 
 * m0t.ARCH: Centrally managed platform state enforcement.
 * Every service verifies its own state (BUILDER.9).
 */

const bus = require('../eventBus');

let platformState = {
    lockdownMode: false,
    maintenanceMode: false
};

// Initial state fetch
const fetchState = async () => {
    try {
        const adminUrl = process.env.ADMIN_SERVICE_URL || 'http://localhost:5014';
        const res = await fetch(`${adminUrl}/internal/status`);
        if (res.ok) {
            const data = await res.json();
            platformState.lockdownMode = data.lockdownMode;
            platformState.maintenanceMode = data.maintenanceMode;
            console.log(`[PLATFORM-GUARD] Synced: L=${platformState.lockdownMode}, M=${platformState.maintenanceMode}`);
        }
    } catch (err) {
        // Fail-open: if admin service is down, don't block the platform unless we already knew we were locked
        // console.warn('[PLATFORM-GUARD] Failed to sync initial state:', err.message);
    }
};

// Start sync and poll every 5 seconds (Point 2: Eventual consistency)
fetchState();
setInterval(fetchState, 5000);

// Listen for real-time updates (Point 2: Event-driven robustness)
bus.on('platform.lockdown', (data) => {
    platformState.lockdownMode = data.enabled;
    console.log(`[PLATFORM-GUARD] Lockdown Mode: ${data.enabled ? 'ACTIVE' : 'INACTIVE'}`);
});

bus.on('platform.maintenance_mode', (data) => {
    platformState.maintenanceMode = data.enabled;
    console.log(`[PLATFORM-GUARD] Maintenance Mode: ${data.enabled ? 'ACTIVE' : 'INACTIVE'}`);
});

/**
 * Middleware: Enforce platform state
 * Point 5 (Refinement): Ensure Admin and Health routes are NEVER blocked.
 */
module.exports = (req, res, next) => {
    // 1. Safety Bypass: Critical routes must ALWAYS be allowed (Point 5)
    const isHealth   = req.path === '/health' || req.path.endsWith('/health');
    const isStatus   = req.path === '/internal/status';
    const isAuth     = req.path === '/login' || req.path === '/register' || req.path.startsWith('/api/auth');
    const isAdminApp = req.path.startsWith('/admin/'); // For admin-service internal routes

    if (isHealth || isStatus || isAuth || isAdminApp) return next();

    // 2. Safety Bypass: Admin role (passed via x-user or verified token) ALWAYS allowed
    // Also bypass for admin-service callService requests (x-admin-email header)
    if ((req.user && req.user.role === 'admin') || req.headers['x-admin-email']) return next();

    // 3. Enforcement: Lockdown Mode
    if (platformState.lockdownMode) {
        return res.status(503).json({
            error: true,
            code: 503,
            message: 'Platform is currently in lockdown mode. Please try again later.'
        });
    }

    // 4. Enforcement: Maintenance Mode (GET allowed, others blocked)
    if (platformState.maintenanceMode && req.method !== 'GET') {
        return res.status(503).json({
            error: true,
            code: 503,
            message: 'Platform is under maintenance. Read-only mode is active.'
        });
    }

    next();
};
