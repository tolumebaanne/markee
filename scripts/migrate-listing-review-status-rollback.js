/**
 * Rollback for migrate-listing-review-status.js
 *
 * Removes the reviewStatus, displayStatus, and offlineBy fields added by the
 * migration, restoring documents to their pre-migration state.
 *
 * This rollback is safe to run at any point before Phase 1 code (which reads
 * reviewStatus/displayStatus) has been deployed. Once Phase 1 is live and
 * buyer-facing routes rely on displayStatus, do NOT roll back without simultaneously
 * reverting the catalog-service code — or all listings will reappear regardless of
 * review state.
 *
 * Run: node scripts/migrate-listing-review-status-rollback.js
 * Safe to re-run (idempotent).
 */

'use strict';

const mongoose = require('mongoose');
const path     = require('path');

// ── Load env ──────────────────────────────────────────────────────────────────
function loadEnv(file) {
    const fs = require('fs');
    if (!fs.existsSync(file)) return;
    const lines = fs.readFileSync(file, 'utf8').split('\n');
    for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;
        const eq = trimmed.indexOf('=');
        if (eq < 0) continue;
        const key = trimmed.slice(0, eq).trim();
        const val = trimmed.slice(eq + 1).trim();
        if (!process.env[key]) process.env[key] = val;
    }
}

const BASE = path.join(__dirname, '..');
loadEnv(path.join(BASE, 'catalog-service/.env'));

const URI = process.env.MONGODB_URI;
if (!URI) { console.error('[rollback] MONGODB_URI not set in catalog-service/.env'); process.exit(1); }

async function run() {
    const conn = await mongoose.createConnection(URI).asPromise();
    console.log('[rollback] Connected to catalog database.');

    const Product = conn.model('Product', new mongoose.Schema({}, { strict: false }), 'products');

    const migrated = await Product.countDocuments({ reviewStatus: { $exists: true } });
    console.log(`[rollback] Products with reviewStatus set: ${migrated}`);

    if (!migrated) {
        console.log('[rollback] No migrated documents found — nothing to roll back.');
        await conn.close();
        process.exit(0);
    }

    const result = await Product.updateMany(
        { reviewStatus: { $exists: true } },
        { $unset: { reviewStatus: '', displayStatus: '', offlineBy: '' } }
    );

    console.log(`\n[rollback] Done. Documents reverted: ${result.modifiedCount}`);
    await conn.close();
    process.exit(0);
}

run().catch(err => { console.error('[rollback] Fatal:', err); process.exit(1); });
