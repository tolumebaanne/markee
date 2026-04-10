/**
 * test_admin_controls.js
 * 
 * Verifies Platform Lockdown and Maintenance Mode enforcement across services.
 * Since obtaining a valid Superuser JWT in a CLI script is complex (requires TOTP),
 * this script modifies the PlatformConfig directly in MongoDB and then tests 
 * service responses via HTTP.
 */

const mongoose = require('mongoose');
const path = require('path');
const fs = require('fs');

// Load Admin Service env for DB URI
// From scripts/test_admin_controls.js, .env is at ../.env
const adminEnvPath = path.join(__dirname, '../.env');
const adminEnvContent = fs.readFileSync(adminEnvPath, 'utf8');
const MONGO_URI_MATCH = adminEnvContent.match(/MONGODB_URI=(.+)/);
const MONGO_URI = MONGO_URI_MATCH ? MONGO_URI_MATCH[1].trim() : null;

if (!MONGO_URI) {
    console.error('Could not find MONGODB_URI in admin-service/.env');
    process.exit(1);
}

async function test() {
    console.log('=== Admin Control Integration Test ===\n');

    const db = mongoose.createConnection(MONGO_URI);
    await new Promise(r => db.once('connected', r));
    console.log('[TEST] Connected to mvp_admin DB');

    const PlatformConfigSchema = new mongoose.Schema({
        _singleton: { type: String, default: 'global' },
        maintenanceMode: Boolean,
        lockdownMode: Boolean
    });
    const PlatformConfig = db.model('PlatformConfig', PlatformConfigSchema);

    // Helper to check gateway connectivity
    const checkStatus = async (path, method = 'GET') => {
        try {
            const res = await fetch(`http://localhost:4000${path}`, { method });
            return res.status;
        } catch (err) {
            return 'ERROR';
        }
    };

    try {
        // 1. Initial State
        console.log('\n--- Normal Mode ---');
        await PlatformConfig.updateOne({ _singleton: 'global' }, { lockdownMode: false, maintenanceMode: false });
        console.log('Request to /api/catalog/products:', await checkStatus('/api/catalog/products'));

        // 2. Lockdown Mode
        console.log('\n--- Lockdown Mode (Block All) ---');
        await PlatformConfig.updateOne({ _singleton: 'global' }, { lockdownMode: true });
        // Give a moment for the check (Polling is 5s)
        console.log('Waiting for state sync (7s)...');
        await new Promise(r => setTimeout(r, 7000));
        const status = await checkStatus('/api/catalog/products');
        console.log('Request to /api/catalog/products (Expected 503):', status);
        if (status === 503) console.log('✅ Lockdown verified.');
        else console.log('❌ Lockdown check failed. (Is the monolith running?)');

        // 3. Maintenance Mode
        console.log('\n--- Maintenance Mode (Read-Only) ---');
        await PlatformConfig.updateOne({ _singleton: 'global' }, { lockdownMode: false, maintenanceMode: true });
        console.log('Waiting for state sync (7s)...');
        await new Promise(r => setTimeout(r, 7000));
        const getStatus = await checkStatus('/api/catalog/products', 'GET');
        const postStatus = await checkStatus('/api/catalog/products', 'POST');
        console.log('GET request (Expected 200 or 4xx):', getStatus);
        console.log('POST request (Expected 503):', postStatus);
        if (postStatus === 503 && getStatus !== 503) console.log('✅ Maintenance mode verified.');
        else console.log('❌ Maintenance mode check failed.');

        // 4. Cleanup
        console.log('\n--- Cleanup ---');
        await PlatformConfig.updateOne({ _singleton: 'global' }, { lockdownMode: false, maintenanceMode: false });
        console.log('Platform returned to normal.');

    } catch (err) {
        console.error('[TEST] Failed:', err.message);
    } finally {
        await db.close();
        console.log('\n=== Test Complete ===');
    }
}

test();
