/**
 * Admin Auth Routes — POST /admin/auth/*
 *
 * Admin login uses the same POST /oauth/authorize endpoint as regular users
 * but with client_id: 'admin-client'. The Admin Service handles the MFA step
 * internally and issues short-lived admin JWTs.
 *
 * JWT expiry: Superuser 10min, spawned admin 15min.
 * Refresh token TTL: Superuser 4h, spawned admin 8h.
 */
const express = require('express');
const router  = express.Router();
const crypto  = require('crypto');
const bcrypt  = require('bcrypt');
const jwt     = require('jsonwebtoken');

const AdminAccount     = require('../models/AdminAccount');
const AdminSession     = require('../models/AdminSession');
const AdminActionLog   = require('../models/AdminActionLog');
const { verifyTotp }   = require('../utils/totp');
const requireAdminAuth = require('../middleware/requireAdminAuth');
const sessionActivity  = require('../middleware/sessionActivity');
const errorResponse    = require('../../shared/utils/errorResponse');
const bus              = require('../../shared/eventBus');

const ADMIN_JWT_SECRET = () => process.env.ADMIN_JWT_SECRET || process.env.JWT_SECRET;

// ── Helpers ───────────────────────────────────────────────────────────────────

function issueAdminJwt(account, sessionId) {
  const expiryMinutes = account.isSuperuser ? 10 : 15;
  return jwt.sign(
    {
      sub:         account.userId.toString(),
      email:       account.email,
      isAdmin:     true,
      isSuperuser: account.isSuperuser,
      sessionId,
      // Scopes in JWT are for informational purposes ONLY.
      // Access control always reads live DB permissions.
      scopes: ['admin:access']
    },
    ADMIN_JWT_SECRET(),
    { expiresIn: `${expiryMinutes}m` }
  );
}

function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

async function createSession(account, ipAddress, userAgent) {
  const sessionId    = crypto.randomBytes(32).toString('hex');
  const refreshToken = crypto.randomBytes(40).toString('hex');
  const refreshTtlMs = account.isSuperuser
    ? (parseInt(process.env.ADMIN_SUPER_SESSION_TTL_MS) || 3 * 24 * 60 * 60 * 1000)  // 3 days
    : (parseInt(process.env.ADMIN_SESSION_TTL_MS)       || 8 * 60 * 60 * 1000);
  const refreshExpiresAt = new Date(Date.now() + refreshTtlMs);

  // Enforce max concurrent sessions — revoke oldest if exceeded
  const activeSessions = await AdminSession.model
    .find({ adminId: account._id, revoked: false })
    .sort({ createdAt: 1 });

  const maxSessions = account.maxConcurrentSessions || (account.isSuperuser ? 1 : 2);
  if (activeSessions.length >= maxSessions) {
    const toRevoke = activeSessions.slice(0, activeSessions.length - maxSessions + 1);
    await AdminSession.model.updateMany(
      { _id: { $in: toRevoke.map(s => s._id) } },
      { revoked: true, invalidatedReason: 'new_session' }
    );
  }

  await AdminSession.model.create({
    sessionId,
    adminId:          account._id,
    isSuperuser:      account.isSuperuser,
    refreshToken,
    refreshTokenHash: hashToken(refreshToken),
    refreshExpiresAt,
    ipAddress:        ipAddress || null,
    userAgent:        userAgent || null
  });

  // Superuser: rotate currentSessionId
  const update = { lastLoginAt: new Date(), lastLoginIp: ipAddress, failedLoginCount: 0 };
  if (account.isSuperuser) update.currentSessionId = sessionId;
  await AdminAccount.model.findByIdAndUpdate(account._id, update);

  return { sessionId, refreshToken };
}

// ── POST /admin/auth/step1 ────────────────────────────────────────────────────
// First step: validate credentials via Auth Service, return mfa_required flag.
// This proxies to the Auth Service rather than storing passwords itself.
router.post('/step1', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return errorResponse(res, 400, 'email and password required');

  try {
    const authPort = process.env.AUTH_SERVICE_URL || 'http://localhost:5001';
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);

    let authRes, authData;
    try {
      authRes = await fetch(`${authPort}/oauth/quick-login`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ email, password }),
        signal:  controller.signal
      });
      clearTimeout(timeout);
      authData = await authRes.json();
    } catch (fetchErr) {
      clearTimeout(timeout);
      return errorResponse(res, 503, 'Auth service unreachable');
    }

    if (!authRes.ok || authData.error) {
      return errorResponse(res, 401, 'Invalid credentials');
    }

    // Look up AdminAccount by email — AdminAccount existence is the authority,
    // not the Auth JWT role (which may be 'user' for legacy or re-registered accounts).
    const decoded = jwt.decode(authData.access_token);
    const account = await AdminAccount.model.findOne({ email, status: 'active' });
    if (!account) return errorResponse(res, 403, 'No active admin account found for this email');

    // Self-heal: if userId was a placeholder from offline bootstrap, update it now
    if (decoded?.sub && account.userId.toString() !== decoded.sub) {
      await AdminAccount.model.findByIdAndUpdate(account._id, { userId: decoded.sub });
      account.userId = decoded.sub;
    }

    // Brute force protection
    if (account.lockedUntil && account.lockedUntil > new Date()) {
      const waitSecs = Math.ceil((account.lockedUntil - Date.now()) / 1000);
      return errorResponse(res, 429, `Account locked. Try again in ${waitSecs}s`);
    }

    // If MFA is required (Superuser always, spawned admin if enabled)
    const mfaRequired = account.isSuperuser || account.mfaEnabled;
    if (mfaRequired) {
      // Issue a short-lived pre-auth token (5 minutes) — used in step2
      const preAuthToken = jwt.sign(
        { sub: account.userId.toString(), step: 'mfa', isAdmin: true },
        ADMIN_JWT_SECRET(),
        { expiresIn: '5m' }
      );
      return res.json({ mfa_required: true, pre_auth_token: preAuthToken });
    }

    // No MFA required — issue full session
    const ip = req.ip || req.headers['x-forwarded-for'];
    const ua = req.headers['user-agent'];
    const { sessionId, refreshToken } = await createSession(account, ip, ua);
    const accessToken = issueAdminJwt(account, sessionId);

    bus.emit('admin.login', { adminId: account._id.toString(), email: account.email, ip, isSuperuser: account.isSuperuser });

    res.json({
      access_token:  accessToken,
      refresh_token: refreshToken,
      token_type:    'Bearer',
      expires_in:    (account.isSuperuser ? 10 : 15) * 60,
      is_superuser:  account.isSuperuser
    });
  } catch (err) {
    console.error('[ADMIN] auth/step1 error:', err.message);
    errorResponse(res, 500, 'Login failed');
  }
});

// ── POST /admin/auth/step2 — MFA verification ─────────────────────────────────
router.post('/step2', async (req, res) => {
  const { pre_auth_token, totp_code, recovery_code } = req.body;
  if (!pre_auth_token) return errorResponse(res, 400, 'pre_auth_token required');
  if (!totp_code && !recovery_code) return errorResponse(res, 400, 'totp_code or recovery_code required');

  let decoded;
  try {
    decoded = jwt.verify(pre_auth_token, ADMIN_JWT_SECRET());
  } catch {
    return errorResponse(res, 401, 'pre_auth_token invalid or expired');
  }

  if (decoded.step !== 'mfa') return errorResponse(res, 400, 'Invalid token step');

  try {
    const account = await AdminAccount.model.findOne({ userId: decoded.sub, status: 'active' });
    if (!account) return errorResponse(res, 403, 'Admin account not found');

    let mfaValid = false;

    if (totp_code && account.mfaSecret) {
      mfaValid = verifyTotp(account.mfaSecret, totp_code);
    }

    // Recovery code path
    if (!mfaValid && recovery_code && account.mfaRecoveryCodes.length > 0) {
      for (let i = 0; i < account.mfaRecoveryCodes.length; i++) {
        const match = await bcrypt.compare(recovery_code.replace(/-/g, ''), account.mfaRecoveryCodes[i]);
        if (match) {
          // Consume the recovery code (single-use)
          account.mfaRecoveryCodes.splice(i, 1);
          await account.save();
          mfaValid = true;
          bus.emit('admin.recovery_code_used', { adminId: account._id.toString(), codesRemaining: account.mfaRecoveryCodes.length });
          break;
        }
      }
    }

    if (!mfaValid) {
      // Track failed attempts
      const attempts = (account.failedLoginCount || 0) + 1;
      const update = { failedLoginCount: attempts };
      if (attempts >= 5) update.lockedUntil = new Date(Date.now() + 15 * 60 * 1000); // 15min lock
      await AdminAccount.model.findByIdAndUpdate(account._id, update);
      return errorResponse(res, 401, 'Invalid MFA code');
    }

    const ip = req.ip || req.headers['x-forwarded-for'];
    const ua = req.headers['user-agent'];
    const { sessionId, refreshToken } = await createSession(account, ip, ua);
    const accessToken = issueAdminJwt(account, sessionId);

    bus.emit('admin.login', { adminId: account._id.toString(), email: account.email, ip, isSuperuser: account.isSuperuser });

    res.json({
      access_token:  accessToken,
      refresh_token: refreshToken,
      token_type:    'Bearer',
      expires_in:    (account.isSuperuser ? 10 : 15) * 60,
      is_superuser:  account.isSuperuser
    });
  } catch (err) {
    console.error('[ADMIN] auth/step2 error:', err.message);
    errorResponse(res, 500, 'MFA verification failed');
  }
});

// ── POST /admin/auth/refresh ───────────────────────────────────────────────────
router.post('/refresh', async (req, res) => {
  const { refresh_token } = req.body;
  if (!refresh_token) return errorResponse(res, 400, 'refresh_token required');

  try {
    const hash    = hashToken(refresh_token);
    const session = await AdminSession.model.findOne({ refreshTokenHash: hash });
    if (!session || session.refreshExpiresAt < new Date()) {
      return errorResponse(res, 401, 'Invalid or expired refresh token');
    }
    // Allow recovery from inactivity revocation — the refresh token is the long-lived credential.
    // Deny only explicit terminations (logout, superseded by new login).
    if (session.revoked && session.invalidatedReason !== 'inactivity') {
      return errorResponse(res, 401, 'Session terminated');
    }

    const account = await AdminAccount.model.findById(session.adminId);
    if (!account || account.status !== 'active') {
      return errorResponse(res, 403, 'Admin account inactive');
    }

    // Superuser: validate session is still the current one
    if (account.isSuperuser && account.currentSessionId !== session.sessionId) {
      await AdminSession.model.findByIdAndUpdate(session._id, { revoked: true, invalidatedReason: 'superseded' });
      return errorResponse(res, 401, 'Superuser session superseded');
    }

    // Rotate refresh token (revoke old, issue new)
    await AdminSession.model.findByIdAndUpdate(session._id, { revoked: true, invalidatedReason: 'rotated' });

    const newRefreshToken = crypto.randomBytes(40).toString('hex');
    const refreshTtlMs    = account.isSuperuser
      ? (parseInt(process.env.ADMIN_SUPER_SESSION_TTL_MS) || 3 * 24 * 60 * 60 * 1000)  // 3 days
      : (parseInt(process.env.ADMIN_SESSION_TTL_MS)       || 8 * 60 * 60 * 1000);
    const refreshExpiresAt = new Date(Date.now() + refreshTtlMs);

    await AdminSession.model.create({
      sessionId:        session.sessionId,  // keep same sessionId
      adminId:          account._id,
      isSuperuser:      account.isSuperuser,
      refreshToken:     newRefreshToken,
      refreshTokenHash: hashToken(newRefreshToken),
      refreshExpiresAt,
      ipAddress:        session.ipAddress,
      userAgent:        session.userAgent
    });

    const accessToken = issueAdminJwt(account, session.sessionId);

    res.json({
      access_token:  accessToken,
      refresh_token: newRefreshToken,
      token_type:    'Bearer',
      expires_in:    (account.isSuperuser ? 10 : 15) * 60
    });
  } catch (err) {
    console.error('[ADMIN] auth/refresh error:', err.message);
    errorResponse(res, 500, 'Refresh failed');
  }
});

// ── POST /admin/auth/logout ────────────────────────────────────────────────────
router.post('/logout', requireAdminAuth, async (req, res) => {
  try {
    await AdminSession.model.findOneAndUpdate(
      { sessionId: req.admin.sessionId },
      { revoked: true, invalidatedReason: 'logout' }
    );
    bus.emit('admin.logout', { adminId: req.admin.id, sessionId: req.admin.sessionId });
    res.json({ success: true });
  } catch (err) {
    errorResponse(res, 500, 'Logout failed');
  }
});

// ── GET /admin/auth/me ─────────────────────────────────────────────────────────
router.get('/me', requireAdminAuth, sessionActivity, (req, res) => {
  const { id, email, isSuperuser, permissions, scopeRestrictions } = req.admin;
  res.json({ id, email, isSuperuser, permissions, scopeRestrictions });
});

module.exports = router;
