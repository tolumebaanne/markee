const mongoose = require('mongoose');
const bcrypt = require('bcrypt');

const UserSchema = new mongoose.Schema({
  email: { type: String, unique: true, required: true },
  passwordHash: { type: String, required: true },
  role: { type: String, enum: ['buyer', 'seller', 'admin'], required: true },
  storeId: { type: mongoose.Schema.Types.ObjectId, ref: 'Store' }, // sellers only
  createdAt: { type: Date, default: Date.now }
});

UserSchema.statics.validatePassword = async function(email, password) {
  const user = await this.findOne({ email });
  if (!user) return null;
  
  const isValid = await bcrypt.compare(password, user.passwordHash);
  if (!isValid) return null;
  
  return user;
};

UserSchema.statics.createUser = async function({ email, password, role }) {
  const hashedPassword = await bcrypt.hash(password, 10);
  return await this.create({
    email,
    passwordHash: hashedPassword,
    role
  });
};

module.exports = mongoose.model('User', UserSchema);
