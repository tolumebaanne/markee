const express = require('express');
const router = express.Router();
const User = require('../models/User');

const requireNotAuth = (req, res, next) => {
  if (req.session && req.session.user) {
    return res.redirect('/');
  }
  next();
};

router.get('/register', requireNotAuth, (req, res) => {
  const error = req.query.error ? `<p style="color: red;">${req.query.error}</p>` : '';
  res.send(`
    <!DOCTYPE html>
    <html>
    <head><title>Register</title></head>
    <body>
      <h1>Register</h1>
      ${error}
      <form method="POST" action="/register">
        <label>Email</label> <input type="email" name="email" required><br/>
        <label>Password</label> <input type="password" name="password" required minlength="6"><br/>
        <label>Role</label> 
        <select name="role">
            <option value="buyer">Buyer</option>
            <option value="seller">Seller</option>
        </select><br/>
        <button type="submit">Register</button>
      </form>
      <a href="/login">Login</a>
    </body>
    </html>
  `);
});

router.post('/register', requireNotAuth, async (req, res) => {
  const { email, password, role } = req.body;
  if (!email || !password || !role) {
    return res.redirect('/register?error=Missing fields');
  }
  try {
    await User.createUser({ email, password, role });
    res.redirect('/login?success=Registration successful');
  } catch (error) {
    res.redirect('/register?error=' + encodeURIComponent(error.message));
  }
});

router.get('/login', requireNotAuth, (req, res) => {
  const error = req.query.error ? `<p style="color: red;">${req.query.error}</p>` : '';
  const success = req.query.success ? `<p style="color: green;">${req.query.success}</p>` : '';
  res.send(`
    <!DOCTYPE html>
    <html>
    <head><title>Login</title></head>
    <body>
      <h1>Login</h1>
      ${success} ${error}
      <form method="POST" action="/login">
        <label>Email</label> <input type="email" name="email" required><br/>
        <label>Password</label> <input type="password" name="password" required><br/>
        <button type="submit">Login</button>
      </form>
      <a href="/register">Register</a>
    </body>
    </html>
  `);
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

router.get('/', (req, res) => {
  if (!req.session.user) return res.redirect('/login');
  res.send(`
    <h1>Welcome ${req.session.user.email} (${req.session.user.role})</h1>
    <form method="POST" action="/logout"><button type="submit">Logout</button></form>
  `);
});

module.exports = router;
