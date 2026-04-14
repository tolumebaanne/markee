/**
 * One-time migration: backfill reviewStatus + displayStatus on all existing Product documents.
 *
 * Background: Phase 1 of the Listing Review feature adds two new fields to ProductSchema:
 *   - reviewStatus: tracks position in the review pipeline
 *   - displayStatus: 'visible' | 'hidden' — controls buyer-facing query results
 *
 * Before the new buyer-facing filter `{ displayStatus: 'visible' }` is applied to catalog
 * routes, every existing product must have these fields set correctly. Without this migration,
 * all existing listings disappear from buyers the moment the filter is applied (marketplace-dark).
 *
 * Mapping (see listing_review_execution_report.md M1 section):
 *
 *   status: 'active'         → reviewStatus: 'published',    displayStatus: 'visible'
 *   status: 'pending_review' → reviewStatus: 'pending_review', displayStatus: 'hidden'
 *   status: 'rejected'       → reviewStatus: 'rejected',      displayStatus: 'hidden'
 *   status: 'paused'         → reviewStatus: 'offline',       displayStatus: 'hidden', offlineBy: 'seller'
 *   status: 'archived'       → reviewStatus: 'archived',      displayStatus: 'hidden'
 *   status: 'deleted'        → reviewStatus: 'archived',      displayStatus: 'hidden'
 *
 * Run:   node scripts/migrate-listing-review-status.js
 * Safe to re-run (idempotent — only touches documents where reviewStatus is not yet set).
 * Rollback: node scripts/migrate-listing-review-status-rollback.js
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
if (!URI) { console.error('[migrate] MONGODB_URI not set in catalog-service/.env'); process.exit(1); }

// ── Status mapping ────────────────────────────────────────────────────────────
// Each entry: { reviewStatus, displayStatus, offlineBy? }
const STATUS_MAP = {
    active:         { reviewStatus: 'published',     displayStatus: 'visible' },
    pending_review: { reviewStatus: 'pending_review', displayStatus: 'hidden' },
    rejected:       { reviewStatus: 'rejected',       displayStatus: 'hidden' },
    paused:         { reviewStatus: 'offline',        displayStatus: 'hidden', offlineBy: 'seller' },
    archived:       { reviewStatus: 'archived',       displayStatus: 'hidden' },
    deleted:        { reviewStatus: 'archived',       displayStatus: 'hidden' },
};

// ── Main ──────────────────────────────────────────────────────────────────────
async function run() {
    const conn = await mongoose.createConnection(URI).asPromise();
    console.log('[migrate] Connected to catalog database.');

    const Product = conn.model('Product', new mongoose.Schema({}, { strict: false }), 'products');

    // Only migrate documents where reviewStatus is not yet set (idempotency).
    const total = await Product.countDocuments({ reviewStatus: { $exists: false } });
    console.log(`[migrate] Products without reviewStatus: ${total}`);

    if (!total) {
        console.log('[migrate] All products already migrated — nothing to do.');
        await conn.close();
        process.exit(0);
    }

    const counts = { visible: 0, hidden: 0, unknown: 0, errors: 0 };

    // Process in batches to avoid cursor timeout on large collections.
    const BATCH = 500;
    let skip = 0;

    while (true) {
        const batch = await Product.find(
            { reviewStatus: { $exists: false } },
            { _id: 1, status: 1 }
        ).skip(skip).limit(BATCH).lean();

        if (!batch.length) break;

        for (const doc of batch) {
            const mapping = STATUS_MAP[doc.status];
            if (!mapping) {
                console.warn(`  [WARN] Unknown status "${doc.status}" on product ${doc._id} — skipping`);
                counts.unknown++;
                continue;
            }

            const update = {
                reviewStatus: mapping.reviewStatus,
                displayStatus: mapping.displayStatus,
            };
            if (mapping.offlineBy) update.offlineBy = mapping.offlineBy;

            try {
                await Product.updateOne({ _id: doc._id }, { $set: update });
                if (mapping.displayStatus === 'visible') counts.visible++;
                else counts.hidden++;
            } catch (err) {
                console.error(`  [ERROR] Failed to update product ${doc._id}: ${err.message}`);
                counts.errors++;
            }
        }

        skip += BATCH;
        console.log(`[migrate] Processed ${Math.min(skip, total)} / ${total}...`);
    }

    console.log('\n[migrate] Migration complete.');
    console.log(`  Set to visible (published):  ${counts.visible}`);
    console.log(`  Set to hidden:               ${counts.hidden}`);
    console.log(`  Unknown status (skipped):    ${counts.unknown}`);
    console.log(`  Errors:                      ${counts.errors}`);

    if (counts.errors > 0) {
        console.warn('[migrate] Some documents had errors. Re-run to retry (idempotent).');
        await conn.close();
        process.exit(1);
    }

    await conn.close();
    process.exit(0);
}

run().catch(err => { console.error('[migrate] Fatal:', err); process.exit(1); });
