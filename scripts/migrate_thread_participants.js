/**
 * One-time migration: fix Thread documents where a participant ObjectId is a
 * Store._id rather than a User._id (storeId contamination from pre-fix thread creation).
 *
 * Problem: threads created via old order-detail.ejs / product.ejs passed item.sellerId
 * (= Store._id) as the recipientId. This caused:
 *   1. Thread invisible to seller (GET /threads queries by personal userId)
 *   2. Real-time delivery miss (socket rooms keyed by personal userId, not storeId)
 *
 * Fix: for each thread where a participant ID matches a Store._id, replace it with
 * that store's sellerId (personal User._id).
 *
 * Run: node scripts/migrate_thread_participants.js
 * Safe to re-run (idempotent).
 *
 * NOTE: Thread._id is a deterministic hash computed from participant IDs. This migration
 * fixes the participants/participantMeta so existing threads become visible and deliverable,
 * but the _id hash stays as-is. New messages initiated from product/order pages after the
 * code fix will compute a new hash (correct sellerId) → a new separate thread. This is
 * accepted: old message history becomes accessible, new conversations start fresh.
 */

'use strict';

const mongoose = require('mongoose');
const path     = require('path');

// ── Load env files for each service ──────────────────────────────────────────
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
        if (!process.env[key]) process.env[key] = val; // don't override
    }
}

const BASE = path.join(__dirname, '..');
loadEnv(path.join(BASE, 'messaging-service/.env'));

const MSG_URI    = process.env.MONGODB_URI;  // mvp_messages
const SELLER_URI = 'mongodb+srv://mebaannet_db_user:emEslHqKzda3EAM1@oauthcluster.ju6keej.mongodb.net/mvp_sellers?appName=OAuthCluster';
const USER_URI   = 'mongodb+srv://mebaannet_db_user:emEslHqKzda3EAM1@oauthcluster.ju6keej.mongodb.net/mvp_users?appName=OAuthCluster';

if (!MSG_URI) { console.error('[migrate] MONGODB_URI not set'); process.exit(1); }

// ── Schemas ───────────────────────────────────────────────────────────────────
const ThreadSchema = new mongoose.Schema({
    _id:             String,
    participants:    [mongoose.Schema.Types.ObjectId],
    participantMeta: [{ userId: mongoose.Schema.Types.ObjectId, displayName: String }]
}, { strict: false });

const UserSchema  = new mongoose.Schema({ _id: mongoose.Schema.Types.ObjectId }, { strict: false });
const StoreSchema = new mongoose.Schema({
    _id:      mongoose.Schema.Types.ObjectId,
    sellerId: mongoose.Schema.Types.ObjectId
}, { strict: false });

// ── Main ──────────────────────────────────────────────────────────────────────
async function run() {
    const msgConn    = await mongoose.createConnection(MSG_URI).asPromise();
    const sellerConn = await mongoose.createConnection(SELLER_URI).asPromise();
    const userConn   = await mongoose.createConnection(USER_URI).asPromise();

    const Thread = msgConn.model('Thread',   ThreadSchema, 'threads');
    const User   = userConn.model('User',    UserSchema,   'users');
    const Store  = sellerConn.model('Store', StoreSchema,  'stores');

    console.log('[migrate] Connected to all databases.');

    // Load all threads
    const threads = await Thread.find({}).lean();
    console.log(`[migrate] Total threads found: ${threads.length}`);
    if (!threads.length) { console.log('[migrate] Nothing to do.'); return cleanup(msgConn, sellerConn, userConn); }

    // Collect all unique participant ObjectId strings
    const allParticipantIds = new Set();
    for (const t of threads) {
        for (const p of (t.participants || [])) allParticipantIds.add(p.toString());
    }

    // Determine which are valid User _ids
    const participantOids = [...allParticipantIds].map(id => new mongoose.Types.ObjectId(id));
    const validUsers      = await User.find({ _id: { $in: participantOids } }).select('_id').lean();
    const validUserIdSet  = new Set(validUsers.map(u => u._id.toString()));

    // Look up Stores for any id not in validUserIds
    const suspectIds  = participantOids.filter(id => !validUserIdSet.has(id.toString()));
    const stores      = await Store.find({ _id: { $in: suspectIds } }).select('_id sellerId').lean();
    const storeToUser = new Map(stores.map(s => [s._id.toString(), s.sellerId?.toString()]));

    console.log(`[migrate] Valid user participants: ${validUserIdSet.size}`);
    console.log(`[migrate] Store IDs needing repair: ${storeToUser.size}`);

    if (!storeToUser.size) {
        console.log('[migrate] No storeId contamination found — all participants are valid user IDs.');
        return cleanup(msgConn, sellerConn, userConn);
    }

    let repaired  = 0;
    let skipped   = 0;
    let unresolved = 0;

    for (const thread of threads) {
        const participants    = thread.participants || [];
        const participantMeta = thread.participantMeta || [];

        const needsRepair = participants.some(p => !validUserIdSet.has(p.toString()) && storeToUser.has(p.toString()));
        if (!needsRepair) { skipped++; continue; }

        const repairedParticipants = participants.map(p => {
            const pStr     = p.toString();
            const sellerId = storeToUser.get(pStr);
            if (sellerId) {
                console.log(`  Thread ${thread._id}: storeId ${pStr} → personalUserId ${sellerId}`);
                return new mongoose.Types.ObjectId(sellerId);
            }
            return p;
        });

        const repairedMeta = participantMeta.map(m => {
            const mStr     = m.userId?.toString();
            const sellerId = mStr && storeToUser.get(mStr);
            if (sellerId) return { ...m, userId: new mongoose.Types.ObjectId(sellerId) };
            return m;
        });

        const changed = repairedParticipants.some((p, i) => p.toString() !== (participants[i] || '').toString());
        if (!changed) { unresolved++; continue; }

        try {
            await Thread.updateOne(
                { _id: thread._id },
                { $set: { participants: repairedParticipants, participantMeta: repairedMeta } }
            );
            repaired++;
        } catch (err) {
            console.error(`  Failed to update thread ${thread._id}: ${err.message}`);
            unresolved++;
        }
    }

    console.log(`\n[migrate] Done.`);
    console.log(`  Repaired:   ${repaired}`);
    console.log(`  Skipped:    ${skipped} (already correct)`);
    console.log(`  Unresolved: ${unresolved} (storeId with no matching Store record)`);

    await cleanup(msgConn, sellerConn, userConn);
}

async function cleanup(...conns) {
    for (const c of conns) await c.close().catch(() => {});
    process.exit(0);
}

run().catch(err => { console.error('[migrate] Fatal:', err); process.exit(1); });
