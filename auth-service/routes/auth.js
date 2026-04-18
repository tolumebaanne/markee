const express = require('express');
const router = express.Router();
const User = require('../models/User');
const RefreshToken = require('../models/RefreshToken');
const bus = require('../../shared/eventBus');
const { body } = require('express-validator');
const handleValidationErrors = require('../../shared/middleware/handleValidationErrors');
const crypto = require('crypto');
const bcrypt = require('bcrypt');
const { sendPasswordResetEmail } = require('../services/mailer');

const ORDER_SERVICE_URL = process.env.ORDER_SERVICE_URL || 'http://localhost:5003';

const requireAuth = (req, res, next) => {
  if (!req.session || !req.session.user) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
};

const requireNotAuth = (req, res, next) => {
  if (req.session && req.session.user) {
    return res.redirect('/');
  }
  next();
};

router.get('/register', requireNotAuth, (req, res) => {
  res.render('register', { error: req.query.error });
});

router.post('/register', requireNotAuth, [
    body('email').isEmail().withMessage('Valid email required').customSanitizer(v => v.toLowerCase().trim()),
    body('password')
        .isLength({ min: 8 }).withMessage('Password must be at least 8 characters')
        .matches(/[0-9]/).withMessage('Password must contain at least one number')
        .matches(/[a-zA-Z]/).withMessage('Password must contain at least one letter'),
    body('displayName').optional().trim().isLength({ max: 50 }).withMessage('Display name too long'),
    body('phone').optional().matches(/^\+?[0-9]{10,15}$/).withMessage('Invalid phone number format')
], handleValidationErrors, async (req, res) => {
  const { email, password, displayName, phone } = req.body;
  if (!email || !password) {
    return res.redirect('/register?error=Email and password are required');
  }
  try {
    const newUser = await User.createUser({ email, password, role: 'user', displayName, phone });
    bus.emit('user.registered', {
      userId:      newUser._id.toString(),
      storeId:     newUser.storeId.toString(),
      email:       newUser.email,
      displayName: newUser.displayName || ''
    });
    res.redirect('/login?success=Registration successful! Please sign in.');
  } catch (error) {
    let msg = error.message;
    if (error.code === 11000 || msg.includes('duplicate key')) {
      msg = 'An account with this email already exists.';
    }
    res.redirect('/register?error=' + encodeURIComponent(msg));
  }
});

router.get('/login', requireNotAuth, (req, res) => {
  res.render('login', { error: req.query.error, success: req.query.success });
});

router.post('/login', requireNotAuth, async (req, res) => {
  const rawEmail = (req.body.email || '').toLowerCase().trim();
  const { password } = req.body;
  if (!rawEmail || !password) return res.redirect('/login?error=Email and password are required');
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(rawEmail)) return res.redirect('/login?error=Enter a valid email address');

  try {
    const user = await User.validatePassword(rawEmail, password);
    if (!user) return res.redirect('/login?error=Invalid credentials');

    // email is mangled after deletion so this check is belt-and-suspenders
    if (user.status === 'deleted') return res.redirect('/login?error=This account no longer exists.');

    if (user.moderationStatus === 'banned') return res.redirect('/login?error=This account has been banned.');
    if (user.moderationStatus === 'suspended') return res.redirect('/login?error=This account has been suspended.');

    req.session.user = {
      id:               user._id.toString(),
      email:            user.email,
      role:             user.role,
      storeId:          user.storeId,
      pendingDeletion:  user.status === 'pending_deletion'
    };
    const returnTo = req.session.returnTo || '/';
    delete req.session.returnTo;
    res.redirect(returnTo);
  } catch (error) {
    res.redirect('/login?error=Login failed');
  }
});

router.post('/logout', (req, res) => {
  req.session.destroy(() => res.redirect('/login'));
});

// ── Self-deletion (Stage 1): initiate 24h cooldown ────────────────────────────

async function initiateSoftDelete(userId, storeId, destroySession) {
  // Check for open seller orders — fail closed if order-service unreachable
  try {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 3000);
    const check = await fetch(
      `${ORDER_SERVICE_URL}/seller-orders-check?storeId=${storeId}`,
      { signal: controller.signal }
    );
    const { hasOpen, count } = await check.json();
    if (hasOpen) {
      return {
        blocked: true,
        message: `You have ${count} open order(s) as a seller. Fulfill or cancel them before deleting your account.`
      };
    }
  } catch (err) {
    console.error('[AUTH] seller-orders-check unreachable — blocking deletion for safety:', err.message);
    return { blocked: true, message: 'Unable to verify your seller orders. Please try again later.' };
  }

  const user = await User.findById(userId);
  if (!user) return { blocked: true, message: 'User not found.' };
  if (user.status === 'pending_deletion') return { blocked: false, alreadyPending: true };

  user.status = 'pending_deletion';
  user.pendingDeletionSince = new Date();
  await user.save();

  // revoke all refresh tokens immediately — this is the actual access enforcement
  await RefreshToken.deleteMany({ userId });

  bus.emit('user.pending_deletion', {
    userId:  userId.toString(),
    storeId: storeId.toString()
  });

  destroySession();
  return { blocked: false };
}

router.delete('/account', requireAuth, async (req, res) => {
  try {
    const { id: userId, storeId } = req.session.user;
    const result = await initiateSoftDelete(userId, storeId, () => req.session.destroy(() => {}));
    if (result.blocked) return res.status(400).json({ error: result.message });
    res.json({
      success: true,
      message: result.alreadyPending
        ? 'Your account is already scheduled for deletion.'
        : 'Your account is scheduled for deletion in 24 hours. You can cancel this from the login page.'
    });
  } catch (err) {
    console.error('[AUTH] Account deletion error:', err);
    res.status(500).json({ error: 'Failed to initiate account deletion' });
  }
});

router.delete('/account-jwt', async (req, res) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'Missing or invalid authorization header' });
    }
    const jwt = require('jsonwebtoken');
    const decoded = jwt.verify(authHeader.split(' ')[1], process.env.JWT_SECRET);
    const userId  = decoded.sub;
    const storeId = decoded.storeId;
    if (!storeId) return res.status(400).json({ error: 'Unable to resolve store for this account.' });

    const result = await initiateSoftDelete(userId, storeId, () => {});
    if (result.blocked) return res.status(400).json({ error: result.message });
    res.json({
      success: true,
      message: result.alreadyPending
        ? 'Your account is already scheduled for deletion.'
        : 'Your account is scheduled for deletion in 24 hours. You can cancel this from your account settings.'
    });
  } catch (err) {
    console.error('[AUTH] JWT account deletion error:', err);
    res.status(500).json({ error: 'Failed to initiate account deletion' });
  }
});

// ── Cancel pending deletion ───────────────────────────────────────────────────

router.post('/account/cancel-deletion', async (req, res) => {
  try {
    let userId;
    if (req.session?.user) {
      userId = req.session.user.id;
    } else {
      // session was destroyed on deletion initiation — re-auth required
      const { email, password } = req.body;
      if (!email || !password) return res.status(401).json({ error: 'Credentials required' });
      const user = await User.validatePassword(email, password);
      if (!user) return res.status(401).json({ error: 'Invalid credentials' });
      userId = user._id.toString();
    }

    const user = await User.findById(userId);
    if (!user) return res.status(404).json({ error: 'User not found' });
    if (user.status !== 'pending_deletion') {
      return res.status(400).json({ error: 'No pending deletion found for this account.' });
    }

    user.status = 'active';
    user.pendingDeletionSince = undefined;
    await user.save();

    bus.emit('user.deletion_cancelled', {
      userId:  userId.toString(),
      storeId: user.storeId.toString()
    });

    res.json({ success: true, message: 'Account deletion cancelled. Your account is restored.' });
  } catch (err) {
    console.error('[AUTH] cancel-deletion error:', err);
    res.status(500).json({ error: 'Failed to cancel deletion' });
  }
});

// ── Hard-delete cascade listener (admin-initiated) ───────────────────────────
// user.deleted with hardDelete: true cleans up the auth record when Super hard-deletes via admin proxy.
bus.on('user.deleted', async (payload) => {
  if (!payload.hardDelete) return;
  try {
    await User.deleteOne({ _id: payload.userId });
    await RefreshToken.deleteMany({ userId: payload.userId });
    console.log(`[AUTH] Hard-deleted auth record for userId ${payload.userId}`);
  } catch (err) {
    console.error('[AUTH] user.deleted hard-delete cleanup error:', err.message);
  }
});

// ── JWT-based password change ─────────────────────────────────────────────────

router.put('/change-password', async (req, res) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'Missing or invalid authorization header' });
    }
    const jwt = require('jsonwebtoken');
    const decoded = jwt.verify(authHeader.split(' ')[1], process.env.JWT_SECRET);
    const { currentPassword, newPassword } = req.body;
    if (!currentPassword || !newPassword) {
      return res.status(400).json({ error: 'currentPassword and newPassword are required' });
    }
    if (newPassword.length < 8) {
      return res.status(400).json({ error: 'New password must be at least 8 characters' });
    }
    const user = await User.findById(decoded.sub);
    if (!user) return res.status(404).json({ error: 'User not found' });
    const bcrypt = require('bcrypt');
    const valid = await bcrypt.compare(currentPassword, user.passwordHash);
    if (!valid) return res.status(403).json({ error: 'Current password is incorrect' });
    user.passwordHash = await bcrypt.hash(newPassword, 10);
    await user.save();
    res.json({ success: true, message: 'Password changed successfully.' });
  } catch (err) {
    console.error('[AUTH] change-password error:', err);
    res.status(500).json({ error: 'Failed to change password' });
  }
});

// ── Mark profile setup complete ───────────────────────────────────────────────
router.post('/setup-done', async (req, res) => {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) return res.status(401).json({ error: 'Unauthorized' });
  try {
    const jwt = require('jsonwebtoken');
    const decoded = jwt.verify(authHeader.split(' ')[1], process.env.JWT_SECRET || 'fallback-secret');
    await User.findByIdAndUpdate(decoded.sub, { profileSetupDone: true });
    res.json({ success: true });
  } catch (err) {
    console.error('[AUTH] setup-done error:', err.message);
    res.status(500).json({ error: 'Failed to mark setup complete' });
  }
});

// ── Admin: list all users (service-to-service, x-admin-email auth) ────────────
router.get('/admin/users', async (req, res) => {
  if (!req.headers['x-admin-email']) return res.status(403).json({ error: 'Admin only' });
  try {
    const { role, status, search, page = 1, limit = 50 } = req.query;
    const query = { status: { $ne: 'deleted' } }; // hide mangled soft-deleted records
    if (role)   query.role              = role;
    if (status) query.moderationStatus  = status;
    if (search) {
      const re = new RegExp(search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
      query.$or = [{ email: re }, { displayName: re }];
    }
    const skip  = (parseInt(page) - 1) * parseInt(limit);
    const total = await User.countDocuments(query);
    const users = await User.find(query)
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(parseInt(limit))
      .select('-passwordHash -originalEmail -pendingDeletionSince');
    res.json({ users, total, page: parseInt(page) });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Mirror moderation state from user-service events so the admin list stays consistent
bus.on('user.suspended', async (payload) => {
  try { await User.findByIdAndUpdate(payload.userId, { $set: { moderationStatus: 'suspended' } }); }
  catch (err) { console.error('[AUTH] user.suspended mirror error:', err.message); }
});
bus.on('user.banned', async (payload) => {
  try { await User.findByIdAndUpdate(payload.userId, { $set: { moderationStatus: 'banned' } }); }
  catch (err) { console.error('[AUTH] user.banned mirror error:', err.message); }
});
bus.on('user.unbanned', async (payload) => {
  try { await User.findByIdAndUpdate(payload.userId, { $set: { moderationStatus: 'active' } }); }
  catch (err) { console.error('[AUTH] user.unbanned mirror error:', err.message); }
});
bus.on('user.role_changed', async (payload) => {
  try { await User.findByIdAndUpdate(payload.userId, { $set: { role: payload.newRole } }); }
  catch (err) { console.error('[AUTH] user.role_changed mirror error:', err.message); }
});
bus.on('user.profile_updated', async (payload) => {
  if (!payload.displayName) return;
  try { await User.findByIdAndUpdate(payload.userId, { $set: { displayName: payload.displayName } }); }
  catch (err) { console.error('[AUTH] user.profile_updated mirror error:', err.message); }
});

router.get('/', (req, res) => {
  if (!req.session.user) return res.redirect('/login');
  res.send(`
    <h1>Welcome ${req.session.user.email} (${req.session.user.role})</h1>
    ${req.session.user.pendingDeletion ? '<p style="color:red">Your account is scheduled for deletion in 24 hours. <a href="/account/cancel-deletion">Cancel deletion</a></p>' : ''}
    <form method="POST" action="/logout"><button type="submit">Logout</button></form>
  `);
});

router.patch('/password', async (req, res) => {
    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith('Bearer ')) {
        return res.status(401).json({ error: true, message: 'Missing or invalid authorization header' });
    }
    try {
        const jwt    = require('jsonwebtoken');
        const decoded = jwt.verify(authHeader.split(' ')[1], process.env.JWT_SECRET);
        const { oldPassword, newPassword } = req.body;
        if (!oldPassword || !newPassword) {
            return res.status(400).json({ error: true, message: 'oldPassword and newPassword are required' });
        }
        if (newPassword.length < 8) {
            return res.status(422).json({ error: true, message: 'New password must be at least 8 characters' });
        }

        const bcrypt  = require('bcrypt');

        const user = await User.findById(decoded.sub || decoded.id);
        if (!user) return res.status(404).json({ error: true, message: 'User not found' });

        const match = await bcrypt.compare(oldPassword, user.passwordHash);
        if (!match) return res.status(403).json({ error: true, message: 'Current password is incorrect' });

        user.passwordHash = await bcrypt.hash(newPassword, 12);
        await user.save();

        await RefreshToken.updateMany({ userId: user._id }, { revoked: true });

        res.json({ message: 'Password updated successfully' });
    } catch (err) {
        console.error('[AUTH] PATCH /password error:', err.message);
        res.status(500).json({ error: true, message: 'Password change failed' });
    }
});

// ── Admin: force-set a user's password (superuser only) ──────────────────────
// No old-password required; all refresh tokens are revoked immediately.
router.post('/admin/users/:id/force-password', async (req, res) => {
  if (!req.headers['x-admin-email']) return res.status(403).json({ error: 'Admin only' });
  const { newPassword } = req.body;
  if (!newPassword || newPassword.length < 8)
    return res.status(400).json({ error: 'newPassword must be at least 8 characters' });
  try {
    const bcrypt = require('bcrypt');
    const user = await User.findById(req.params.id);
    if (!user || user.status === 'deleted') return res.status(404).json({ error: 'User not found' });
    user.passwordHash = await bcrypt.hash(newPassword, 10);
    await user.save();
    await RefreshToken.updateMany({ userId: user._id }, { revoked: true });
    console.log(`[AUTH] Admin ${req.headers['x-admin-email']} force-reset password for user ${user.email}`);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Admin: revoke all sessions (force logout) for a user ─────────────────────
router.post('/admin/users/:id/revoke-sessions', async (req, res) => {
  if (!req.headers['x-admin-email']) return res.status(403).json({ error: 'Admin only' });
  try {
    const user = await User.findById(req.params.id);
    if (!user) return res.status(404).json({ error: 'User not found' });
    const result = await RefreshToken.updateMany({ userId: user._id }, { revoked: true });
    console.log(`[AUTH] Admin ${req.headers['x-admin-email']} revoked ${result.modifiedCount} sessions for user ${user.email}`);
    res.json({ success: true, revokedCount: result.modifiedCount });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Admin: hard-delete user record + all refresh tokens ──────────────────────
router.delete('/admin/users/:id', async (req, res) => {
  if (!req.headers['x-admin-email']) return res.status(403).json({ error: 'Admin only' });
  try {
    const user = await User.findByIdAndDelete(req.params.id);
    if (!user) return res.status(404).json({ error: 'User not found' });
    const tokenResult = await RefreshToken.deleteMany({ userId: user._id });
    console.log(`[AUTH] Admin ${req.headers['x-admin-email']} hard-deleted user ${user.email} — ${tokenResult.deletedCount} refresh token(s) purged`);
    bus.emit('user.deleted', { userId: req.params.id, email: user.email });
    res.json({ userId: req.params.id, deleted: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Forgot Password ───────────────────────────────────────────────────────────
// same response whether email exists or not (no enumeration); only SHA-256 hash stored in DB

router.get('/forgot-password', (req, res) => {
  res.render('forgot-password', { sent: req.query.sent === '1', error: req.query.error });
});

router.post('/forgot-password', express.urlencoded({ extended: false }), async (req, res) => {
  const GENERIC_REDIRECT = '/forgot-password?sent=1';
  try {
    const email = (req.body.email || '').toLowerCase().trim();
    if (!email) return res.redirect(GENERIC_REDIRECT);

    const user = await User.findOne({ email, status: { $ne: 'deleted' } });
    if (!user) return res.redirect(GENERIC_REDIRECT); // no enumeration — same response

    // Soft rate-limit: if an unexpired token exists, don't spam
    if (user.resetTokenExpiry && user.resetTokenExpiry > new Date()) {
      return res.redirect(GENERIC_REDIRECT);
    }

    const rawToken = crypto.randomBytes(32).toString('hex');
    const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');
    user.resetToken = tokenHash;
    user.resetTokenExpiry = new Date(Date.now() + 60 * 60 * 1000);
    await user.save();

    const base = (process.env.APP_BASE_URL || 'http://localhost:4000').replace(/\/$/, '');
    const resetLink = `${base}/reset-password?token=${rawToken}`;
    await sendPasswordResetEmail(email, resetLink);

    return res.redirect(GENERIC_REDIRECT);
  } catch (err) {
    console.error('[AUTH] forgot-password error:', err.message);
    return res.redirect(GENERIC_REDIRECT); // fail safely, no leakage
  }
});

// ── Reset Password ────────────────────────────────────────────────────────────

router.get('/reset-password', async (req, res) => {
  const { token } = req.query;
  if (!token) return res.render('reset-password', { valid: false, error: 'Invalid or missing reset link.' });

  try {
    const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
    const user = await User.findOne({
      resetToken: tokenHash,
      resetTokenExpiry: { $gt: new Date() }
    });
    if (!user) return res.render('reset-password', { valid: false, error: 'This link is invalid or has expired. Please request a new one.' });
    res.render('reset-password', { valid: true, token, error: null });
  } catch (err) {
    console.error('[AUTH] reset-password GET error:', err.message);
    res.render('reset-password', { valid: false, error: 'Something went wrong. Please try again.' });
  }
});

router.post('/reset-password', express.urlencoded({ extended: false }), async (req, res) => {
  const { token, newPassword, confirmPassword } = req.body || {};

  if (!token || !newPassword) {
    return res.render('reset-password', { valid: !!token, token, error: 'All fields are required.' });
  }
  if (newPassword !== confirmPassword) {
    return res.render('reset-password', { valid: true, token, error: 'Passwords do not match.' });
  }
  if (newPassword.length < 8) {
    return res.render('reset-password', { valid: true, token, error: 'Password must be at least 8 characters.' });
  }

  try {
    const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
    const user = await User.findOne({
      resetToken: tokenHash,
      resetTokenExpiry: { $gt: new Date() }
    });

    if (!user) {
      return res.render('reset-password', { valid: false, error: 'This link is invalid or has expired. Please request a new one.' });
    }

    user.passwordHash   = await bcrypt.hash(newPassword, 12);
    user.resetToken     = null;
    user.resetTokenExpiry = null;
    await user.save();
    await RefreshToken.deleteMany({ userId: user._id });

    console.log(`[AUTH] Password reset successful for ${user.email}`);
    return res.redirect('/login?success=Password+reset+successful.+Please+sign+in+with+your+new+password.');
  } catch (err) {
    console.error('[AUTH] reset-password POST error:', err.message);
    return res.render('reset-password', { valid: true, token, error: 'Reset failed. Please try again.' });
  }
});

module.exports = router;
