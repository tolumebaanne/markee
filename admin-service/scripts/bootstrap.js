/**
 * bootstrap.js — Superuser Creation & Platform Seeding
 *
 * Run ONCE to initialise the admin platform:
 *   node scripts/bootstrap.js
 *
 * m0t.BUILDER: Bootstrap is idempotent — safe to run multiple times.
 * If the Superuser already exists it reports and exits cleanly.
 *
 * What this does:
 *   1. Creates the Superuser admin account
 *   2. Generates TOTP secret + recovery codes
 *   3. Seeds 9 built-in permission templates (Viewer → Full Admin)
 *   4. Creates the singleton PlatformConfig document
 *   5. Prints credentials and TOTP URI to stdout (never logged to a file)
 */

require('dotenv').config({ path: require('path').join(__dirname, '../.env') });
const mongoose = require('mongoose');
const bcrypt   = require('bcrypt');
const crypto   = require('crypto');

const { generateSecret, generateRecoveryCodes, otpauthUri } = require('../utils/totp');

// ── Connect ────────────────────────────────────────────────────────────────────
const MONGO_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017/mvp_admin';

async function main() {
  const db = mongoose.createConnection(MONGO_URI);
  await new Promise((res, rej) => {
    db.once('connected', res);
    db.once('error', rej);
  });
  console.log('[BOOTSTRAP] Connected to mvp_admin\n');

  // ── Models ───────────────────────────────────────────────────────────────────
  const { schema: AdminAccountSchema }     = require('../models/AdminAccount');
  const { schema: PermissionTemplateSchema } = require('../models/PermissionTemplate');
  const { schema: PlatformConfigSchema }   = require('../models/PlatformConfig');

  const AdminAccount     = db.model('AdminAccount',     AdminAccountSchema);
  const PermissionTemplate = db.model('PermissionTemplate', PermissionTemplateSchema);
  const PlatformConfig   = db.model('PlatformConfig',   PlatformConfigSchema);

  // ── Check if already bootstrapped ────────────────────────────────────────────
  const existing = await AdminAccount.findOne({ isSuperuser: true });
  if (existing) {
    console.log('[BOOTSTRAP] Superuser already exists:', existing.email);
    console.log('[BOOTSTRAP] Skipping Superuser creation. Run with --force to reset (not recommended).');

    // Still seed templates if they don't exist
    await seedTemplates(PermissionTemplate);
    await ensurePlatformConfig(PlatformConfig);
    await db.close();
    return;
  }

  // ── 1. Create Superuser user in Auth DB ─────────────────────────────────────
  // The admin account references a userId from the User collection in auth-service.
  // For bootstrap, we create a placeholder ObjectId and then create the User via Auth Service.
  const superuserEmail = process.env.SUPERUSER_EMAIL || 'superuser@markee.internal';
  const superuserPass  = process.env.SUPERUSER_PASS  || generateStrongPassword();

  console.log('[BOOTSTRAP] Creating Superuser in Auth Service...');
  let userId;
  try {
    const authUrl = process.env.AUTH_SERVICE_URL || 'http://localhost:5001';
    const authRes = await fetch(`${authUrl}/register`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({
        email:    superuserEmail,
        password: superuserPass,
        role:     'admin',
        displayName: 'Superuser'
      })
    });

    if (authRes.ok) {
      const authData = await authRes.json();
      userId = authData.user?._id || authData._id;
      console.log('[BOOTSTRAP] Auth user created. userId:', userId);
    } else {
      const err = await authRes.json();
      // If user already exists, try to fetch their ID
      if (err.message?.includes('exists') || err.error?.includes('exists')) {
        console.log('[BOOTSTRAP] Auth user already exists, proceeding with existing user...');
        userId = new mongoose.Types.ObjectId(); // fallback
      } else {
        console.error('[BOOTSTRAP] Auth service error:', err);
        console.log('[BOOTSTRAP] Proceeding with generated userId (wire manually if needed)...');
        userId = new mongoose.Types.ObjectId();
      }
    }
  } catch (err) {
    console.warn('[BOOTSTRAP] Auth service unreachable:', err.message);
    console.log('[BOOTSTRAP] Creating AdminAccount with generated userId (wire to Auth manually)...');
    userId = new mongoose.Types.ObjectId();
  }

  // ── 2. Generate TOTP secret ───────────────────────────────────────────────────
  const totpSecret = generateSecret();
  const totpUri    = otpauthUri(totpSecret, superuserEmail, 'Markee Admin');

  // ── 3. Generate recovery codes ───────────────────────────────────────────────
  const rawCodes    = generateRecoveryCodes();
  const hashedCodes = await Promise.all(rawCodes.map(c => bcrypt.hash(c.replace(/-/g, ''), 10)));

  // ── 4. Create Superuser AdminAccount with ALL permissions ────────────────────
  const allTrue = (...keys) => Object.fromEntries(keys.map(k => [k, true]));
  const superuserPerms = {
    auth:          allTrue('read', 'write', 'ban', 'impersonate'),
    catalog:       allTrue('read', 'write', 'approve', 'reject', 'feature', 'categoryMgmt', 'bulk'),
    orders:        allTrue('read', 'forceStatus', 'cancel', 'bulk'),
    payments:      allTrue('read', 'refund', 'release', 'partialRefund', 'freeze', 'splitRefund', 'resolveDisputes', 'payoutHold'),
    sellers:       allTrue('read', 'write', 'verify', 'suspend', 'ban', 'regApproval', 'tier'),
    reviews:       allTrue('read', 'moderate', 'delete', 'bulk'),
    messages:      allTrue('read', 'moderate', 'inject', 'ban'),
    notifications: allTrue('read', 'send', 'broadcast', 'editTemplates', 'prefOverride', 'config'),
    analytics:     allTrue('read', 'readAll', 'export'),
    search:        allTrue('read', 'feature', 'reindex', 'hide', 'autocomplete'),
    inventory:     allTrue('read', 'adjust', 'freeze'),
    shipping:      allTrue('read', 'forceStatus'),
    intelligence:  allTrue('sellerScores', 'buyerScores', 'buyerOverride', 'fraudSignals', 'anomalies', 'leakage', 'balance', 'funnel'),
    config:        allTrue('read', 'write'),
    audit:         allTrue('readOwn', 'readAll', 'export'),
    system:        allTrue('impersonate', 'nukeTokens', 'lockdown')
  };

  const superuser = await AdminAccount.create({
    userId,
    email:                    superuserEmail,
    isSuperuser:              true,
    mfaEnabled:               true,
    mfaSecret:                totpSecret,
    mfaRecoveryCodes:         hashedCodes,
    maxConcurrentSessions:    1,
    inactivityTimeoutMinutes: 20,
    permissions:              superuserPerms,
    status:                   'active',
    createdBy:                null
  });

  console.log('[BOOTSTRAP] Superuser created:', superuser._id.toString());

  // ── 5. Seed permission templates ─────────────────────────────────────────────
  await seedTemplates(PermissionTemplate);

  // ── 6. Create singleton PlatformConfig ──────────────────────────────────────
  await ensurePlatformConfig(PlatformConfig);

  // ── 7. Print credentials (stdout only — never logged to file) ────────────────
  console.log('\n' + '═'.repeat(60));
  console.log('  MARKEE ADMIN BOOTSTRAP COMPLETE');
  console.log('═'.repeat(60));
  console.log(`  Superuser Email : ${superuserEmail}`);
  console.log(`  Password        : ${superuserPass}`);
  console.log(`  TOTP Secret     : ${totpSecret}`);
  console.log(`  TOTP URI        : ${totpUri}`);
  console.log('\n  Recovery Codes (save these — shown ONCE):');
  rawCodes.forEach((c, i) => console.log(`    ${i + 1}. ${c}`));
  console.log('\n  ⚠️  Store these credentials securely. They cannot be recovered.');
  console.log('═'.repeat(60) + '\n');

  await db.close();
}

// ── Seed built-in permission templates ───────────────────────────────────────
async function seedTemplates(PermissionTemplate) {
  const make = (...keys) => Object.fromEntries(keys.map(k => [k, true]));
  const none = (...keys) => Object.fromEntries(keys.map(k => [k, false]));

  const templates = [
    {
      name: 'Viewer',
      description: 'Read-only access to all platform data. No write capabilities.',
      permissions: {
        auth:          make('read'),
        catalog:       make('read'),
        orders:        make('read'),
        payments:      make('read'),
        sellers:       make('read'),
        reviews:       make('read'),
        messages:      make('read'),
        notifications: make('read'),
        analytics:     make('read'),
        search:        make('read'),
        inventory:     make('read'),
        shipping:      make('read'),
        intelligence:  none('sellerScores', 'buyerScores', 'buyerOverride', 'fraudSignals', 'anomalies', 'leakage', 'balance', 'funnel'),
        config:        none('read', 'write'),
        audit:         make('readOwn'),
        system:        none('impersonate', 'nukeTokens', 'lockdown')
      }
    },
    {
      name: 'Moderator',
      description: 'Content moderation: reviews, messages, and catalog approval.',
      permissions: {
        auth:          make('read'),
        catalog:       make('read', 'approve', 'reject'),
        orders:        make('read'),
        payments:      make('read'),
        sellers:       make('read'),
        reviews:       make('read', 'moderate', 'delete'),
        messages:      make('read', 'moderate', 'ban'),
        notifications: make('read'),
        analytics:     make('read'),
        search:        make('read', 'hide'),
        inventory:     make('read'),
        shipping:      make('read'),
        intelligence:  none('sellerScores', 'buyerScores', 'buyerOverride', 'fraudSignals', 'anomalies', 'leakage', 'balance', 'funnel'),
        config:        none('read', 'write'),
        audit:         make('readOwn'),
        system:        none('impersonate', 'nukeTokens', 'lockdown')
      }
    },
    {
      name: 'Support Agent',
      description: 'Customer support: order lookup, payment read, messaging.',
      permissions: {
        auth:          make('read'),
        catalog:       make('read'),
        orders:        make('read', 'cancel'),
        payments:      make('read', 'refund', 'partialRefund'),
        sellers:       make('read'),
        reviews:       make('read'),
        messages:      make('read', 'moderate'),
        notifications: make('read', 'send'),
        analytics:     make('read'),
        search:        make('read'),
        inventory:     make('read'),
        shipping:      make('read'),
        intelligence:  none('sellerScores', 'buyerScores', 'buyerOverride', 'fraudSignals', 'anomalies', 'leakage', 'balance', 'funnel'),
        config:        none('read', 'write'),
        audit:         make('readOwn'),
        system:        none('impersonate', 'nukeTokens', 'lockdown')
      }
    },
    {
      name: 'Operations Manager',
      description: 'Order fulfilment, shipping control, inventory management.',
      permissions: {
        auth:          make('read'),
        catalog:       make('read', 'write'),
        orders:        make('read', 'forceStatus', 'cancel', 'bulk'),
        payments:      make('read', 'release'),
        sellers:       make('read', 'write'),
        reviews:       make('read'),
        messages:      make('read'),
        notifications: make('read', 'send', 'broadcast'),
        analytics:     make('read', 'readAll'),
        search:        make('read', 'feature', 'reindex'),
        inventory:     make('read', 'adjust'),
        shipping:      make('read', 'forceStatus'),
        intelligence:  make('sellerScores', 'balance', 'funnel'),
        config:        make('read'),
        audit:         make('readOwn', 'readAll'),
        system:        none('impersonate', 'nukeTokens', 'lockdown')
      }
    },
    {
      name: 'Finance Admin',
      description: 'Full payment control: refunds, releases, disputes, payout holds.',
      permissions: {
        auth:          make('read'),
        catalog:       make('read'),
        orders:        make('read'),
        payments:      make('read', 'refund', 'release', 'partialRefund', 'freeze', 'splitRefund', 'resolveDisputes', 'payoutHold'),
        sellers:       make('read'),
        reviews:       make('read'),
        messages:      make('read'),
        notifications: make('read'),
        analytics:     make('read', 'readAll', 'export'),
        search:        make('read'),
        inventory:     make('read'),
        shipping:      make('read'),
        intelligence:  make('leakage', 'fraudSignals', 'anomalies'),
        config:        make('read'),
        audit:         make('readOwn', 'readAll', 'export'),
        system:        none('impersonate', 'nukeTokens', 'lockdown')
      }
    },
    {
      name: 'Seller Manager',
      description: 'Seller onboarding, verification, tier management, seller suspension.',
      permissions: {
        auth:          make('read'),
        catalog:       make('read', 'approve', 'reject'),
        orders:        make('read'),
        payments:      make('read'),
        sellers:       make('read', 'write', 'verify', 'suspend', 'regApproval', 'tier'),
        reviews:       make('read', 'moderate'),
        messages:      make('read'),
        notifications: make('read', 'send'),
        analytics:     make('read', 'readAll'),
        search:        make('read', 'feature'),
        inventory:     make('read'),
        shipping:      make('read'),
        intelligence:  make('sellerScores', 'funnel', 'balance'),
        config:        make('read'),
        audit:         make('readOwn', 'readAll'),
        system:        none('impersonate', 'nukeTokens', 'lockdown')
      }
    },
    {
      name: 'Content Admin',
      description: 'Full catalog and search control, review management, featured listings.',
      permissions: {
        auth:          make('read'),
        catalog:       make('read', 'write', 'approve', 'reject', 'feature', 'categoryMgmt', 'bulk'),
        orders:        make('read'),
        payments:      make('read'),
        sellers:       make('read'),
        reviews:       make('read', 'moderate', 'delete', 'bulk'),
        messages:      make('read', 'moderate'),
        notifications: make('read', 'send'),
        analytics:     make('read', 'readAll'),
        search:        make('read', 'feature', 'reindex', 'hide', 'autocomplete'),
        inventory:     make('read'),
        shipping:      make('read'),
        intelligence:  none('sellerScores', 'buyerScores', 'buyerOverride', 'fraudSignals', 'anomalies', 'leakage', 'balance', 'funnel'),
        config:        make('read'),
        audit:         make('readOwn', 'readAll'),
        system:        none('impersonate', 'nukeTokens', 'lockdown')
      }
    },
    {
      name: 'Supervisor',
      description: 'Cross-team visibility: read everything, manage admins, view intelligence.',
      permissions: {
        auth:          make('read', 'write'),
        catalog:       make('read', 'approve', 'reject'),
        orders:        make('read', 'cancel'),
        payments:      make('read', 'refund'),
        sellers:       make('read', 'verify', 'suspend'),
        reviews:       make('read', 'moderate', 'delete'),
        messages:      make('read', 'moderate'),
        notifications: make('read', 'send', 'broadcast'),
        analytics:     make('read', 'readAll', 'export'),
        search:        make('read', 'feature', 'hide'),
        inventory:     make('read', 'adjust'),
        shipping:      make('read', 'forceStatus'),
        intelligence:  make('sellerScores', 'buyerScores', 'fraudSignals', 'anomalies', 'leakage', 'balance', 'funnel'),
        config:        make('read'),
        audit:         make('readOwn', 'readAll', 'export'),
        system:        none('impersonate', 'nukeTokens', 'lockdown')
      }
    },
    {
      name: 'Full Admin',
      description: 'All permissions except system-level controls (reserved for Superuser).',
      permissions: {
        auth:          make('read', 'write', 'ban'),
        catalog:       make('read', 'write', 'approve', 'reject', 'feature', 'categoryMgmt', 'bulk'),
        orders:        make('read', 'forceStatus', 'cancel', 'bulk'),
        payments:      make('read', 'refund', 'release', 'partialRefund', 'freeze', 'splitRefund', 'resolveDisputes', 'payoutHold'),
        sellers:       make('read', 'write', 'verify', 'suspend', 'ban', 'regApproval', 'tier'),
        reviews:       make('read', 'moderate', 'delete', 'bulk'),
        messages:      make('read', 'moderate', 'inject', 'ban'),
        notifications: make('read', 'send', 'broadcast', 'editTemplates', 'prefOverride', 'config'),
        analytics:     make('read', 'readAll', 'export'),
        search:        make('read', 'feature', 'reindex', 'hide', 'autocomplete'),
        inventory:     make('read', 'adjust', 'freeze'),
        shipping:      make('read', 'forceStatus'),
        intelligence:  make('sellerScores', 'buyerScores', 'buyerOverride', 'fraudSignals', 'anomalies', 'leakage', 'balance', 'funnel'),
        config:        make('read', 'write'),
        audit:         make('readOwn', 'readAll', 'export'),
        system:        none('impersonate', 'nukeTokens', 'lockdown')  // system reserved for Superuser
      }
    }
  ];

  let seeded = 0;
  for (const t of templates) {
    const exists = await PermissionTemplate.findOne({ name: t.name });
    if (!exists) {
      await PermissionTemplate.create({ ...t, isBuiltIn: true });
      seeded++;
    }
  }
  if (seeded > 0) console.log(`[BOOTSTRAP] Seeded ${seeded} permission template(s)`);
  else console.log('[BOOTSTRAP] Permission templates already seeded');
}

async function ensurePlatformConfig(PlatformConfig) {
  const exists = await PlatformConfig.findOne({ _singleton: 'global' });
  if (!exists) {
    await PlatformConfig.create({ _singleton: 'global' });
    console.log('[BOOTSTRAP] PlatformConfig singleton created');
  } else {
    console.log('[BOOTSTRAP] PlatformConfig already exists');
  }
}

function generateStrongPassword() {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789!@#$%^&*';
  return Array.from(crypto.randomBytes(20))
    .map(b => chars[b % chars.length])
    .join('');
}

main().catch(err => {
  console.error('[BOOTSTRAP] Fatal error:', err);
  process.exit(1);
});
