/**
 * repair-superuser.js
 *
 * Diagnoses and repairs the superuser AdminAccount record.
 *
 * Run from the Markee root with the monolith STOPPED:
 *   node admin-service/scripts/repair-superuser.js
 *
 * What it does:
 *   1. Connects to the admin DB
 *   2. Prints the current state of every AdminAccount
 *   3. Finds the superuser account (or the one matching SUPERUSER_EMAIL)
 *   4. Fixes isSuperuser: true if it is false
 *   5. Sets status: 'active' if it is not
 *   6. Resets currentSessionId to null — forces a clean session on next login
 *   7. Revokes all AdminSessions for that account — forces fresh MFA login
 *
 * After running: restart the monolith, log in as superuser, verify GOD MODE badge appears.
 */

require('dotenv').config({ path: require('path').join(__dirname, '../.env') });
const mongoose = require('mongoose');

const MONGO_URI       = process.env.MONGODB_URI || 'mongodb://localhost:27017/mvp_admin';
const SUPERUSER_EMAIL = process.env.SUPERUSER_EMAIL || 'superuser@markee.internal';

const { schema: AdminAccountSchema } = require('../models/AdminAccount');
const { schema: AdminSessionSchema  } = require('../models/AdminSession');

async function main() {
  const db = mongoose.createConnection(MONGO_URI);
  await new Promise((res, rej) => {
    db.once('open', res);
    db.once('error', rej);
  });
  console.log('[REPAIR] Connected to', MONGO_URI, '\n');

  const AdminAccount = db.model('AdminAccount', AdminAccountSchema);
  const AdminSession  = db.model('AdminSession',  AdminSessionSchema);

  // ── 1. Show current state ─────────────────────────────────────────────────────
  const allAccounts = await AdminAccount.find({}).lean();
  console.log(`[REPAIR] AdminAccount records found: ${allAccounts.length}`);
  allAccounts.forEach(a => {
    console.log(`  • ${a.email}  isSuperuser=${a.isSuperuser}  status=${a.status}  currentSessionId=${a.currentSessionId || 'none'}`);
  });
  console.log('');

  if (allAccounts.length === 0) {
    console.error('[REPAIR] ❌  No AdminAccount records found at all.');
    console.error('         Run bootstrap first:  node admin-service/scripts/bootstrap.js');
    await db.close();
    process.exit(1);
  }

  // ── 2. Locate the superuser record ────────────────────────────────────────────
  let target = allAccounts.find(a => a.isSuperuser === true);
  if (!target) {
    // isSuperuser is false on all records — find by email and fix
    target = allAccounts.find(a => a.email === SUPERUSER_EMAIL);
    if (!target) {
      console.error(`[REPAIR] ❌  No account with email "${SUPERUSER_EMAIL}" found.`);
      console.error('         Run bootstrap to create the superuser account.');
      await db.close();
      process.exit(1);
    }
    console.log(`[REPAIR] ⚠️  Found account ${target.email} but isSuperuser is FALSE — this is the root cause.`);
  } else {
    console.log(`[REPAIR] ✓  Found superuser account: ${target.email}`);
  }

  // ── 3. Apply all repairs ──────────────────────────────────────────────────────
  const repairs = {
    isSuperuser:       true,
    status:            'active',
    currentSessionId:  null,          // force clean session on next login
    failedLoginCount:  0,
    lockedUntil:       null
  };

  const result = await AdminAccount.updateOne({ _id: target._id }, { $set: repairs });
  console.log(`[REPAIR] AdminAccount updated — matched=${result.matchedCount}  modified=${result.modifiedCount}`);

  // ── 4. Revoke all stale sessions ──────────────────────────────────────────────
  const sessionResult = await AdminSession.updateMany(
    { adminId: target._id },
    { $set: { revoked: true, invalidatedReason: 'repair' } }
  );
  console.log(`[REPAIR] AdminSessions revoked: ${sessionResult.modifiedCount}`);

  // ── 5. Final state ────────────────────────────────────────────────────────────
  const fixed = await AdminAccount.findById(target._id).lean();
  console.log('\n[REPAIR] Final state:');
  console.log(`  email            : ${fixed.email}`);
  console.log(`  isSuperuser      : ${fixed.isSuperuser}`);
  console.log(`  status           : ${fixed.status}`);
  console.log(`  currentSessionId : ${fixed.currentSessionId || 'null (correct)'}`);
  console.log(`  failedLoginCount : ${fixed.failedLoginCount}`);

  if (fixed.isSuperuser && fixed.status === 'active' && !fixed.currentSessionId) {
    console.log('\n[REPAIR] ✅  Superuser account is healthy.');
    console.log('         Restart the monolith and log in as superuser.');
    console.log('         You MUST go through MFA again (sessions were cleared).');
  } else {
    console.error('\n[REPAIR] ❌  Unexpected state after repair. Check the DB manually.');
  }

  await db.close();
}

main().catch(err => {
  console.error('[REPAIR] Fatal error:', err.message);
  process.exit(1);
});
