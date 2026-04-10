const mongoose = require('mongoose');

let db = null;

async function connectDB() {
  const uri = process.env.MONGODB_URI;
  if (!uri) { console.error('[ADMIN] MONGODB_URI not set'); process.exit(1); }

  db = mongoose.createConnection(uri);
  db.on('connected', () => console.log('[ADMIN] DB Connected → mvp_admin'));
  db.on('error', (err) => console.error('[ADMIN] DB error:', err.message));

  return db;
}

function getDB() {
  if (!db) throw new Error('[ADMIN] DB not initialised — call connectDB() first');
  return db;
}

module.exports = { connectDB, getDB };
