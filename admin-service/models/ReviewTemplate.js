const mongoose = require('mongoose');

const ReviewTemplateSchema = new mongoose.Schema({
  title:      { type: String, required: true, trim: true, maxlength: 100 },
  body:       { type: String, required: true, trim: true, minlength: 10, maxlength: 1000 },
  category:   { type: String, trim: true, default: '' },  // e.g. 'images', 'description', 'pricing'
  isActive:   { type: Boolean, default: true },
  createdBy:  { type: mongoose.Schema.Types.ObjectId, required: true },
  usageCount: { type: Number, default: 0 },
  createdAt:  { type: Date, default: Date.now },
  updatedAt:  { type: Date, default: null }
});

ReviewTemplateSchema.index({ isActive: 1, category: 1 });

let _model = null;
module.exports = {
  schema: ReviewTemplateSchema,
  init: (db) => { _model = db.model('ReviewTemplate', ReviewTemplateSchema); return _model; },
  get model() { return _model; }
};
