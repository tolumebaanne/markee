const mongoose = require('mongoose');

const PermissionTemplateSchema = new mongoose.Schema({
  name:        { type: String, required: true, unique: true },
  description: { type: String, default: '' },
  isBuiltIn:   { type: Boolean, default: false },  // built-in presets cannot be deleted

  permissions: { type: mongoose.Schema.Types.Mixed, required: true },

  createdBy: { type: mongoose.Schema.Types.ObjectId, default: null },
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now }
});

let _model = null;
module.exports = {
  schema: PermissionTemplateSchema,
  init: (db) => { _model = db.model('PermissionTemplate', PermissionTemplateSchema); return _model; },
  get model() { return _model; }
};
