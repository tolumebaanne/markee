/**
 * migrate-roles.js
 * One-time migration: updates all 'buyer' and 'seller' role values to 'user'.
 * Run once: node auth-service/scripts/migrate-roles.js
 */
require('dotenv').config({ path: require('path').join(__dirname, '../.env') });
const mongoose = require('mongoose');

async function migrate() {
  await mongoose.connect(process.env.MONGODB_URI);
  const db = mongoose.connection;
  const result = await db.collection('users').updateMany(
    { role: { $in: ['buyer', 'seller'] } },
    { $set: { role: 'user' } }
  );
  console.log(`Migrated ${result.modifiedCount} user(s) from buyer/seller → user`);
  await mongoose.disconnect();
}

migrate().catch(err => { console.error(err); process.exit(1); });
