require('dotenv').config({ path: require('path').join(__dirname, '.env') });
const express = require('express');
const cors    = require('cors');
const mongoose= require('mongoose');

const errorResponse = require('../shared/utils/errorResponse');
const platformGuard = require('../shared/middleware/platformGuard');
const { registerListeners } = require('./events/listeners');

const app  = express();
const PORT = process.env.PORT || 5014;

app.use(express.json());
app.use(cors());

// ── DB connection ─────────────────────────────────────────────────────────────
const db = mongoose.createConnection(process.env.MONGODB_URI || 'mongodb://localhost:27017/mvp_admin');
db.on('connected', () => {
  console.log('[ADMIN] DB Connected → mvp_admin');
  // Initialise all models once the connection is live
  require('./models/AdminAccount').init(db);
  require('./models/PermissionTemplate').init(db);
  require('./models/AdminSession').init(db);
  require('./models/AdminActionLog').init(db);
  require('./models/PlatformConfig').init(db);
  require('./models/ReviewTemplate').init(db);
  require('./models/ReviewAssignment').init(db);
  console.log('[ADMIN] Models initialised');
});
db.on('error', (err) => console.error('[ADMIN] DB error:', err.message));

// ── Event listeners ───────────────────────────────────────────────────────────
registerListeners();

app.use(platformGuard);

// ── Internal Status Endpoint (for platformGuard) ─────────────────────────────
app.get('/internal/status', async (req, res) => {
  // Point 1: Shore up security - Internal-only check
  const isLocal = ['::1', '127.0.0.1', '::ffff:127.0.0.1'].includes(req.ip);
  if (!isLocal && process.env.NODE_ENV === 'production') {
    return res.status(403).json({ error: 'Internal only' });
  }

  try {
    const PlatformConfig = require('./models/PlatformConfig');
    const config = await PlatformConfig.model.findOne({ _singleton: 'global' });
    res.json({
      lockdownMode:    config?.lockdownMode || false,
      maintenanceMode: config?.maintenanceMode || false
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Internal: list accounts that can review listings (for notification fan-out) ─
app.get('/internal/reviewers', async (req, res) => {
  const isLocal = ['::1', '127.0.0.1', '::ffff:127.0.0.1'].includes(req.ip);
  if (!isLocal && process.env.NODE_ENV === 'production') {
    return res.status(403).json({ error: 'Internal only' });
  }
  try {
    const AdminAccount = require('./models/AdminAccount');
    const reviewers = await AdminAccount.model.find({
      $or: [
        { isSuperuser: true },
        { 'permissions.listingReview.canReview': true }
      ],
      status: { $ne: 'suspended' }
    }).select('userId email').lean();
    res.json(reviewers);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Routes ────────────────────────────────────────────────────────────────────
// Gateway mounts at /api/admin and strips that prefix before forwarding,
// so routes here are relative (no /admin prefix needed).
app.use('/auth',            require('./routes/auth'));
app.use('/accounts',        require('./routes/accounts'));
app.use('/templates',       require('./routes/templates'));
app.use('/system',          require('./routes/system'));
app.use('/intelligence',    require('./routes/intelligence'));
app.use('/proxy',           require('./routes/proxy'));
app.use('/listing-review',  require('./routes/listingReview'));

// ── Health check ──────────────────────────────────────────────────────────────
app.get('/health', (req, res) => {
  res.json({
    service: 'admin-service',
    status:  'ok',
    dbState: db.readyState === 1 ? 'connected' : 'disconnected',
    port:    PORT
  });
});

// ── 404 handler ───────────────────────────────────────────────────────────────
app.use((req, res) => errorResponse(res, 404, `Admin Service: ${req.method} ${req.path} not found`));

// ── Error handler ─────────────────────────────────────────────────────────────
app.use((err, req, res, next) => {
  console.error('[ADMIN] Unhandled error:', err.message);
  errorResponse(res, 500, err.message || 'Admin Service Internal Error');
});

app.listen(PORT, () => console.log(`[ADMIN] Admin Service on port ${PORT}`));

module.exports = app;
