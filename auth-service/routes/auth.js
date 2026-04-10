const express = require('express');
const router = express.Router();
const User = require('../models/User');
const RefreshToken = require('../models/RefreshToken');
const bus = require('../../shared/eventBus');
const { body } = require('express-validator');
const handleValidationErrors = require('../../shared/middleware/handleValidationErrors');

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
    body('email').isEmail().normalizeEmail().withMessage('Valid email required'),
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
    res.redirect('/register?error=' + encodeURIComponent(error.message));
  }
});

router.get('/login', requireNotAuth, (req, res) => {
  res.render('login', { error: req.query.error, success: req.query.success });
});

router.post('/login', requireNotAuth, async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.redirect('/login?error=Missing credentials');

  try {
    const user = await User.validatePassword(email, password);
    if (!user) return res.redirect('/login?error=Invalid credentials');

    // Block fully soft-deleted accounts (email is mangled so this is belt-and-suspenders)
    if (user.status === 'deleted') return res.redirect('/login?error=This account no longer exists.');

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

  // Revoke all refresh tokens immediately — this is the actual access enforcement
  await RefreshToken.deleteMany({ userId });

  bus.emit('user.pending_deletion', {
    userId:  userId.toString(),
    storeId: storeId.toString()
  });

  destroySession();
  return { blocked: false };
}

// Session-based deletion
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

// JWT-based deletion (called from API gateway frontend)
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
    // Accepts session auth or password re-authentication
    let userId;
    if (req.session?.user) {
      userId = req.session.user.id;
    } else {
      // Password re-auth for users whose session was destroyed on deletion initiation
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
// Auth-service owns its own record. When Super hard-deletes via admin proxy,
// user.deleted fires with hardDelete: true — this cleans up the auth record.
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
  try { await User.findByIdAndUpdate(payload.userId, { moderationStatus: 'suspended' }); }
  catch (err) { console.error('[AUTH] user.suspended mirror error:', err.message); }
});
bus.on('user.banned', async (payload) => {
  try { await User.findByIdAndUpdate(payload.userId, { moderationStatus: 'banned' }); }
  catch (err) { console.error('[AUTH] user.banned mirror error:', err.message); }
});
bus.on('user.unbanned', async (payload) => {
  try { await User.findByIdAndUpdate(payload.userId, { moderationStatus: 'active' }); }
  catch (err) { console.error('[AUTH] user.unbanned mirror error:', err.message); }
});

router.get('/', (req, res) => {
  if (!req.session.user) return res.redirect('/login');
  res.send(`
    <h1>Welcome ${req.session.user.email} (${req.session.user.role})</h1>
    ${req.session.user.pendingDeletion ? '<p style="color:red">Your account is scheduled for deletion in 24 hours. <a href="/account/cancel-deletion">Cancel deletion</a></p>' : ''}
    <form method="POST" action="/logout"><button type="submit">Logout</button></form>
  `);
});

// PATCH /password — change password (requires valid access token)
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

        // Revoke all existing refresh tokens for this user
        await RefreshToken.updateMany({ userId: user._id }, { revoked: true });

        res.json({ message: 'Password updated successfully' });
    } catch (err) {
        console.error('[AUTH] PATCH /password error:', err.message);
        res.status(500).json({ error: true, message: 'Password change failed' });
    }
});

module.exports = router;
