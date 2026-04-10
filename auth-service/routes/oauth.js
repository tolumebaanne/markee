const express = require('express');
const router = express.Router();
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const AuthCode = require('../models/AuthCode');
const RefreshToken = require('../models/RefreshToken');
const User = require('../models/User');

// ── Dynamic scope computation ─────────────────────────────────────────────────
// Queries the Seller Service to determine if the user's store is currently active,
// then returns the correct scope set and storeActive flag for JWT issuance.
const BUYER_SCOPES  = ['catalog:read', 'orders:create', 'orders:read', 'reviews:write', 'messages:read', 'messages:write'];
const SELLER_SCOPES = ['catalog:write', 'inventory:write', 'orders:fulfil', 'shipping:write', 'analytics:read'];
const ADMIN_SCOPES  = ['orders:*', 'catalog:*', 'sellers:*', 'payments:*', 'reviews:moderate', 'analytics:*', 'inventory:*', 'shipping:*', 'messages:*'];

async function computeScopes(user) {
  if (user.role === 'admin') {
    return { scopes: ADMIN_SCOPES, storeActive: false };
  }

  let scopes = [...BUYER_SCOPES];
  let storeActive = false;

  if (user.storeId) {
    // 3-second timeout prevents a slow/hung Seller Service from blocking token issuance.
    const controller = new AbortController();
    const timeout    = setTimeout(() => controller.abort(), 3000);

    try {
      const sellerPort = process.env.SELLER_PORT || 5005;
      const res = await fetch(`http://localhost:${sellerPort}/${user.storeId}`, {
        signal: controller.signal
      });
      clearTimeout(timeout);

      if (res.ok) {
        const store = await res.json();
        // `active` defaults to true if the field hasn't been written yet (existing stores).
        storeActive = store.active !== false;
        if (storeActive) scopes = [...scopes, ...SELLER_SCOPES];
      } else if (res.status === 404) {
        // Store document not created yet — new user, no seller scopes.
        storeActive = false;
      } else {
        // Non-404 error from Seller Service — fail open: any user with a storeId
        // gets seller scopes rather than losing access due to a transient service error.
        storeActive = true;
        scopes = [...scopes, ...SELLER_SCOPES];
      }
    } catch (e) {
      clearTimeout(timeout);
      // Seller Service unreachable or request timed out.
      // Fail open: grant seller scopes to users who have a storeId so a Seller Service
      // outage does not log out all sellers. A buyer has no storeId so is unaffected.
      storeActive = true;
      scopes = [...scopes, ...SELLER_SCOPES];
    }
  }

  return { scopes, storeActive };
}

const requireAuth = (req, res, next) => {
  if (!req.session.user) {
    // Pass returnTo as a URL param so it survives even if the session cookie
    // is lost in transit through the reverse proxy (production).
    const next_ = encodeURIComponent(req.originalUrl);
    return res.redirect(`/oauth/login?next=${next_}`);
  }
  next();
};

// ── OAuth-scoped login (credential entry for the authorize flow) ──────────────
// Lives at /oauth/login so it's proxied through the gateway alongside /oauth/authorize.
// After successful sign-in, redirects to req.session.returnTo (the authorize URL).

router.get('/login', (req, res) => {
  // If already logged in, proceed to where they were going
  if (req.session?.user) {
    const dest = req.query.next || req.session.returnTo || '/oauth/authorize';
    return res.redirect(dest);
  }
  // No next= and no session returnTo = direct visit with no context — bounce to gateway /login
  const nextUrl = req.query.next || req.session?.returnTo || '';
  if (!nextUrl) return res.redirect('/login');
  res.render('oauth-login', { error: req.query.error || null, nextUrl });
});

router.post('/login', async (req, res) => {
  const { email, password, next: nextUrl } = req.body;
  const returnTo = nextUrl || req.session?.returnTo || '/oauth/authorize';

  if (!email || !password) {
    return res.render('oauth-login', { error: 'Email and password are required.', nextUrl: returnTo });
  }
  try {
    const user = await User.validatePassword(email, password);
    if (!user) return res.render('oauth-login', { error: 'Invalid email or password.', nextUrl: returnTo });
    if (user.status === 'deleted') return res.render('oauth-login', { error: 'This account no longer exists.', nextUrl: returnTo });
    if (user.moderationStatus === 'banned') return res.render('oauth-login', { error: 'This account has been banned.', nextUrl: returnTo });

    req.session.user = {
      id:              user._id.toString(),
      email:           user.email,
      role:            user.role,
      storeId:         user.storeId,
      pendingDeletion: user.status === 'pending_deletion'
    };

    delete req.session.returnTo;
    res.redirect(returnTo);
  } catch (err) {
    console.error('[AUTH] oauth/login error:', err);
    res.render('oauth-login', { error: 'Login failed. Please try again.', nextUrl: returnTo });
  }
});

function generateAuthCode() {
  return crypto.randomBytes(32).toString('hex');
}

// First-party clients that get auto-approved (no consent screen)
const FIRST_PARTY_CLIENTS = ['markee-gateway'];

async function issueCode(req, res, authReq) {
  const code = generateAuthCode();
  try {
    await AuthCode.create({
      code,
      userId: req.session.user.id,
      clientId: authReq.client_id,
      scope: authReq.scope,
      redirectUri: authReq.redirect_uri,
      expiresAt: new Date(Date.now() + 10 * 60 * 1000)
    });
    const redirectUrl = new URL(authReq.redirect_uri);
    redirectUrl.searchParams.append('code', code);
    redirectUrl.searchParams.append('state', authReq.state);
    console.log(`[AUTH] Code issued for ${authReq.client_id}, redirecting to: ${redirectUrl}`);
    res.redirect(redirectUrl.toString());
  } catch (err) {
    console.error('[AUTH] issueCode error:', err);
    res.status(500).send('Internal server error');
  }
}

// GET /oauth/authorize
router.get('/authorize', requireAuth, async (req, res) => {
  const { response_type, client_id, redirect_uri, state, scope } = req.query;

  if (response_type !== 'code') return res.status(400).send('Invalid response_type. Must be code');
  if (!client_id || !redirect_uri || !state) return res.status(400).send('Missing req params');

  const authReq = {
    client_id, redirect_uri, state,
    scope: scope ? scope.split(' ') : []
  };

  // First-party clients: skip consent screen, issue code immediately
  if (FIRST_PARTY_CLIENTS.includes(client_id)) {
    return issueCode(req, res, authReq);
  }

  req.session.authRequest = authReq;
  res.render('authorize', { email: req.session.user.email });
});

router.post('/authorize/approve', requireAuth, async (req, res) => {
  const authReq = req.session.authRequest;
  if (!authReq) return res.status(400).send('No valid auth request found');

  const code = generateAuthCode();
  try {
    console.log(`[AUTH] Approving for clientId: ${authReq.client_id}, redirect: ${authReq.redirect_uri}`);
    await AuthCode.create({
      code,
      userId: req.session.user.id,
      clientId: authReq.client_id,
      scope: authReq.scope,
      redirectUri: authReq.redirect_uri,
      expiresAt: new Date(Date.now() + 10 * 60 * 1000)
    });
    delete req.session.authRequest;

    const redirectUrl = new URL(authReq.redirect_uri);
    redirectUrl.searchParams.append('code', code);
    redirectUrl.searchParams.append('state', authReq.state);
    const destination = redirectUrl.toString();
    console.log(`[AUTH] Redirecting to: ${destination}`);
    res.redirect(destination);
  } catch (error) {
    console.error(`[AUTH] Approval Error:`, error);
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

// POST /oauth/quick-login — direct credential to JWT (for same-origin modal sign-in)
router.post('/quick-login', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'Missing credentials' });

  try {
    const user = await User.validatePassword(email, password);
    if (!user) return res.status(401).json({ error: 'Invalid email or password' });

    const { scopes, storeActive } = await computeScopes(user);

    const payload = {
      sub:             user._id.toString(),
      email:           user.email,
      role:            user.role === 'admin' ? 'admin' : 'user',
      storeId:         user.storeId?.toString() || null,
      storeActive,
      displayName:     user.displayName || '',
      scopes,
      pendingDeletion: user.status === 'pending_deletion',
      exp: Math.floor(Date.now() / 1000) + (60 * 60), // 1 hour
    };

    const accessToken = jwt.sign(payload, process.env.JWT_SECRET || 'fallback-secret');
    const refreshToken = crypto.randomBytes(40).toString('hex');
    await RefreshToken.create({ token: refreshToken, userId: user._id });

    res.json({ access_token: accessToken, refresh_token: refreshToken, token_type: 'Bearer', expires_in: 3600, role: payload.role });
  } catch (err) {
    console.error('[AUTH] quick-login error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

router.post('/token', async (req, res) => {
  const { grant_type, code, redirect_uri, client_id, client_secret } = req.body;
  if (grant_type !== 'authorization_code') return res.status(400).json({ error: 'unsupported_grant_type' });

  try {
    const authCodeDoc = await AuthCode.findOne({ code }).populate('userId');
    if (!authCodeDoc) {
      console.log(`[AUTH] Auth Code not found: ${code}`);
      return res.status(400).json({ error: 'invalid_grant', detail: 'code_not_found' });
    }
    if (authCodeDoc.used || authCodeDoc.expiresAt < new Date() || authCodeDoc.clientId !== client_id || authCodeDoc.redirectUri !== redirect_uri) {
      console.log(`[AUTH] Validation failed:`, {
        used: authCodeDoc.used,
        expired: authCodeDoc.expiresAt < new Date(),
        clientIdMatch: authCodeDoc.clientId === client_id,
        uriMatch: authCodeDoc.redirectUri === redirect_uri,
        storedUri: authCodeDoc.redirectUri,
        passedUri: redirect_uri
      });
      return res.status(400).json({ error: 'invalid_grant' });
    }

    authCodeDoc.used = true;
    await authCodeDoc.save();

    const user = authCodeDoc.userId;
    const { scopes, storeActive } = await computeScopes(user);
    const payload = {
      sub:             user._id.toString(),
      email:           user.email,
      role:            user.role === 'admin' ? 'admin' : 'user',
      storeId:         user.storeId?.toString() || null,
      storeActive,
      displayName:     user.displayName || '',
      scopes,
      pendingDeletion: user.status === 'pending_deletion',
      exp: Math.floor(Date.now() / 1000) + (60 * 60) // 1 hour
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
    const { scopes, storeActive } = await computeScopes(user);
    const payload = {
      sub:             user._id.toString(),
      email:           user.email,
      role:            user.role === 'admin' ? 'admin' : 'user',
      storeId:         user.storeId?.toString() || null,
      storeActive,
      displayName:     user.displayName || '',
      scopes,
      pendingDeletion: user.status === 'pending_deletion',
      exp: Math.floor(Date.now() / 1000) + (60 * 60)
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
