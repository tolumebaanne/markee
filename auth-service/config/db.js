const mongoose = require('mongoose');

async function connectDB() {
  const uri = process.env.MONGODB_URI;
  if (!uri) { console.error('[AUTH] MONGODB_URI not set'); process.exit(1); }

  try {
    await mongoose.connect(uri);
    console.log('MongoDB connected successfully via Mongoose');
  } catch (error) {
    console.error('Failed to connect to MongoDB:', error);
    process.exit(1);
  }
}

module.exports = {
  connectDB
};
