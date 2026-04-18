const bus = require('../eventBus');

let platformState = {
    lockdownMode: false,
    maintenanceMode: false
};

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

fetchState();
setInterval(fetchState, 5000);

bus.on('platform.lockdown', (data) => {
    platformState.lockdownMode = data.enabled;
    console.log(`[PLATFORM-GUARD] Lockdown Mode: ${data.enabled ? 'ACTIVE' : 'INACTIVE'}`);
});

bus.on('platform.maintenance_mode', (data) => {
    platformState.maintenanceMode = data.enabled;
    console.log(`[PLATFORM-GUARD] Maintenance Mode: ${data.enabled ? 'ACTIVE' : 'INACTIVE'}`);
});

module.exports = (req, res, next) => {
    const isHealth   = req.path === '/health' || req.path.endsWith('/health');
    const isStatus   = req.path === '/internal/status';
    const isAuth     = req.path === '/login' || req.path === '/register' || req.path.startsWith('/api/auth');
    const isAdminApp = req.path.startsWith('/admin/'); // For admin-service internal routes

    if (isHealth || isStatus || isAuth || isAdminApp) return next();

    // x-admin-email header also bypasses — admin-service callService requests are not JWT-authenticated
    if ((req.user && req.user.role === 'admin') || req.headers['x-admin-email']) return next();

    if (platformState.lockdownMode) {
        return res.status(503).json({
            error: true,
            code: 503,
            message: 'Platform is currently in lockdown mode. Please try again later.'
        });
    }

    if (platformState.maintenanceMode && req.method !== 'GET') {
        return res.status(503).json({
            error: true,
            code: 503,
            message: 'Platform is under maintenance. Read-only mode is active.'
        });
    }

    next();
};
