/**
 * bootstrap-seller-stores.js
 *
 * One-time migration for the Unified Identity Model rollout.
 *
 * Problem: Before the UIM, users who registered with role='seller' may never
 * have had a Store document created in the Seller Service DB (the route had to
 * be called explicitly from the frontend). After the role migration (buyer/seller → user),
 * these users have a valid storeId in their auth record but computeScopes() gets a
 * 404 from the Seller Service → storeActive: false → seller panel hidden in dashboard.
 *
 * Fix: Create a minimal placeholder Store document for every user who has a storeId
 * but no matching store in the seller DB. The store is created with active: true so
 * computeScopes() immediately grants seller scopes on next login/refresh.
 *
 * Run once:
 *   node auth-service/scripts/bootstrap-seller-stores.js
 *
 * Safe to re-run — uses findOneAndUpdate with upsert:false (only inserts missing docs).
 */

const path = require('path');

// Load auth-service env (has MONGODB_URI for the auth DB)
require('dotenv').config({ path: path.join(__dirname, '../.env') });
const AUTH_URI = process.env.MONGODB_URI;

// Load seller-service env for its MONGODB_URI
const fs   = require('fs');
const sellerEnvPath = path.join(__dirname, '../../seller-service/.env');
let SELLER_URI = '';
if (fs.existsSync(sellerEnvPath)) {
    fs.readFileSync(sellerEnvPath, 'utf8').split('\n').forEach(line => {
        const [k, ...rest] = line.split('=');
        if (k && k.trim() === 'MONGODB_URI') SELLER_URI = rest.join('=').trim();
    });
}
if (!SELLER_URI) {
    console.error('Could not read MONGODB_URI from seller-service/.env');
    process.exit(1);
}

const mongoose = require('mongoose');

async function run() {
    // ── Connect to both DBs ────────────────────────────────────────────────────
    const authConn   = await mongoose.createConnection(AUTH_URI).asPromise();
    const sellerConn = await mongoose.createConnection(SELLER_URI).asPromise();

    console.log('Connected to auth DB and seller DB.');

    // ── Schemas (minimal — only the fields we need) ───────────────────────────
    const UserSchema = new mongoose.Schema({
        email:   String,
        storeId: mongoose.Schema.Types.ObjectId,
        role:    String,
    });
    const StoreSchema = new mongoose.Schema({
        _id:         mongoose.Schema.Types.ObjectId,
        sellerId:    mongoose.Schema.Types.ObjectId,
        name:        String,
        description: String,
        active:      Boolean,
        createdAt:   Date,
    });

    const User  = authConn.model('User', UserSchema);
    const Store = sellerConn.model('Store', StoreSchema);

    // ── Find all users with a storeId ─────────────────────────────────────────
    const users = await User.find({ storeId: { $exists: true } });
    console.log(`Found ${users.length} user(s) with a storeId.`);

    let created = 0;
    let skipped = 0;

    for (const u of users) {
        const existing = await Store.findById(u.storeId);
        if (existing) {
            skipped++;
            continue;
        }

        // Create a minimal placeholder store — seller can fill in details from the dashboard
        await Store.create({
            _id:         u.storeId,
            sellerId:    u._id,
            name:        u.email.split('@')[0] + "'s Store", // sensible default
            description: '',
            active:      true,
            createdAt:   new Date(),
        });
        created++;
        console.log(`  Created store for user ${u.email} (storeId: ${u.storeId})`);
    }

    console.log(`\nDone. Created: ${created}  Skipped (already existed): ${skipped}`);
    await authConn.close();
    await sellerConn.close();
}

run().catch(err => { console.error(err); process.exit(1); });
