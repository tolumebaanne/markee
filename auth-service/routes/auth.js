const express = require('express');
const router = express.Router();
const User = require('../models/User');
const bus = require('../../shared/eventBus');

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

router.post('/register', requireNotAuth, async (req, res) => {
  const { email, password, displayName, phone } = req.body;
  if (!email || !password) {
    return res.redirect('/register?error=Email and password are required');
  }
  try {
    const newUser = await User.createUser({ email, password, role: 'user', displayName, phone });
    bus.emit('user.registered', {
      userId:      newUser._id.toString(),
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
    
    req.session.user = { id: user._id.toString(), email: user.email, role: user.role, storeId: user.storeId };
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

router.delete('/account', requireAuth, async (req, res) => {
  try {
    const userId = req.session.user.id;
    console.log(`[AUTH] Deleting account (session): ${userId}`);
    const userDoc = await User.findByIdAndDelete(userId);
    bus.emit('user.deleted', {
      userId,
      storeId: userDoc?.storeId?.toString()
    });
    req.session.destroy(() => {
      res.json({ success: true, message: 'Account and associated data removed.' });
    });
  } catch (err) {
    console.error('[AUTH] Account deletion error:', err);
    res.status(500).json({ error: 'Failed to delete account' });
  }
});

// JWT-based account deletion (called from frontend with Bearer token)
router.delete('/account-jwt', async (req, res) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'Missing or invalid authorization header' });
    }
    const jwt = require('jsonwebtoken');
    const decoded = jwt.verify(authHeader.split(' ')[1], process.env.JWT_SECRET);
    const userId = decoded.sub;
    console.log(`[AUTH] Deleting account (JWT): ${userId}`);
    const userDoc = await User.findByIdAndDelete(userId);
    if (!userDoc) return res.status(404).json({ error: 'User not found' });
    
    bus.emit('user.deleted', {
      userId,
      storeId: userDoc.storeId?.toString()
    });
    res.json({ success: true, message: 'Account and associated data removed.' });
  } catch (err) {
    console.error('[AUTH] JWT account deletion error:', err);
    res.status(500).json({ error: 'Failed to delete account' });
  }
});


// JWT-based password change
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

router.get('/', (req, res) => {
  if (!req.session.user) return res.redirect('/login');
  res.send(`
    <h1>Welcome ${req.session.user.email} (${req.session.user.role})</h1>
    <form method="POST" action="/logout"><button type="submit">Logout</button></form>
  `);
});

module.exports = router;
