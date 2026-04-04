const express = require('express');
const router = express.Router();
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const AuthCode = require('../models/AuthCode');
const RefreshToken = require('../models/RefreshToken');
const User = require('../models/User');

const requireAuth = (req, res, next) => {
  if (!req.session.user) {
    req.session.returnTo = req.originalUrl;
    return res.redirect('/login');
  }
  next();
};

function generateAuthCode() {
  return crypto.randomBytes(32).toString('hex');
}

// GET /oauth/authorize
router.get('/authorize', requireAuth, (req, res) => {
  const { response_type, client_id, redirect_uri, state, scope } = req.query;
  
  if (response_type !== 'code') return res.status(400).send('Invalid response_type. Must be code');
  if (!client_id || !redirect_uri || !state) return res.status(400).send('Missing req params');

  req.session.authRequest = {
    client_id, redirect_uri, state,
    scope: scope ? scope.split(' ') : []
  };

  res.send(`
      <!DOCTYPE html>
      <html>
      <head><title>Authorize App</title></head>
      <body>
        <h1>Authorize Approval</h1>
        <p>Allow the app to access your account as ${req.session.user.email}?</p>
        <form method="POST" action="/oauth/authorize/approve">
            <button type="submit">Approve</button>
        </form>
        <form method="POST" action="/oauth/authorize/deny">
            <button type="submit">Deny</button>
        </form>
      </body>
      </html>
  `);
});

router.post('/authorize/approve', requireAuth, async (req, res) => {
  const authReq = req.session.authRequest;
  if (!authReq) return res.status(400).send('No valid auth request found');

  const code = generateAuthCode();
  try {
    await AuthCode.create({
      code,
      userId: req.session.user.id,
      clientId: authReq.client_id,
      scope: authReq.scope,
      redirectUri: authReq.redirect_uri
    });
    delete req.session.authRequest;

    const redirectUrl = new URL(authReq.redirect_uri);
    redirectUrl.searchParams.append('code', code);
    redirectUrl.searchParams.append('state', authReq.state);
    res.redirect(redirectUrl.toString());
  } catch (error) {
    res.status(500).send('Internal server error');
  }
});

router.post('/authorize/deny', requireAuth, (req, res) => {
  const authReq = req.session.authRequest;
  if (!authReq) return res.status(400).send('No valid auth request found');
  delete req.session.authRequest;

  const redirectUrl = new URL(authReq.redirect_uri);
  redirectUrl.searchParams.append('error', 'access_denied');
  redirectUrl.searchParams.append('state', authReq.state);
  res.redirect(redirectUrl.toString());
});

router.post('/token', async (req, res) => {
  const { grant_type, code, redirect_uri, client_id, client_secret } = req.body;
  if (grant_type !== 'authorization_code') return res.status(400).json({ error: 'unsupported_grant_type' });

  try {
    const authCodeDoc = await AuthCode.findOne({ code }).populate('userId');
    if (!authCodeDoc || authCodeDoc.used || authCodeDoc.expiresAt < new Date() || authCodeDoc.clientId !== client_id || authCodeDoc.redirectUri !== redirect_uri) {
      return res.status(400).json({ error: 'invalid_grant' });
    }

    authCodeDoc.used = true; // Rule 6: Auth codes are single-use
    await authCodeDoc.save();

    const user = authCodeDoc.userId;
    const payload = {
      sub: user._id.toString(),
      role: user.role,
      storeId: user.storeId,
      scopes: authCodeDoc.scope,
      exp: Math.floor(Date.now() / 1000) + (15 * 60) // 15 min
    };
    const accessToken = jwt.sign(payload, process.env.JWT_SECRET || 'fallback-secret');
    
    const refreshToken = crypto.randomBytes(40).toString('hex');
    await RefreshToken.create({
      token: refreshToken,
      userId: user._id
    });

    res.json({
      access_token: accessToken,
      refresh_token: refreshToken,
      token_type: 'Bearer',
      expires_in: 900
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'server_error' });
  }
});

router.post('/refresh', async (req, res) => {
  const { refresh_token } = req.body;
  if (!refresh_token) return res.status(400).json({ error: 'missing_token' });

  try {
    const rtDoc = await RefreshToken.findOne({ token: refresh_token }).populate('userId');
    if (!rtDoc || rtDoc.revoked || rtDoc.expiresAt < new Date()) {
      return res.status(400).json({ error: 'invalid_grant' });
    }

    rtDoc.revoked = true;
    await rtDoc.save();

    const user = rtDoc.userId;
    const scopes = [];
    const payload = {
      sub: user._id.toString(),
      role: user.role,
      storeId: user.storeId,
      scopes,
      exp: Math.floor(Date.now() / 1000) + (15 * 60)
    };
    
    const accessToken = jwt.sign(payload, process.env.JWT_SECRET || 'fallback-secret');
    const newRefreshToken = crypto.randomBytes(40).toString('hex');
    await RefreshToken.create({
      token: newRefreshToken,
      userId: user._id
    });

    res.json({
      access_token: accessToken,
      refresh_token: newRefreshToken,
      token_type: 'Bearer',
      expires_in: 900
    });
  } catch (err) {
    res.status(500).json({ error: 'server_error' });
  }
});

router.post('/revoke', async (req, res) => {
  const { refresh_token } = req.body;
  if (!refresh_token) return res.json({ success: true });

  await RefreshToken.findOneAndUpdate({ token: refresh_token }, { revoked: true });
  res.json({ success: true });
});

module.exports = router;
