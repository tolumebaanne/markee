const mongoose = require('mongoose');

// Immutable audit log of every assignment action taken by Super/Admin.
// The product documents themselves hold the live assignedTo field;
// this collection is the history trail.
const ReviewAssignmentSchema = new mongoose.Schema({
  type:         { type: String, enum: ['assign', 'reassign', 'pullback', 'return'], required: true },
  assignedBy:   { type: mongoose.Schema.Types.ObjectId, required: true },
  assignedTo:   { type: mongoose.Schema.Types.ObjectId, default: null },  // null = returned to pool
  listings:     [{ type: mongoose.Schema.Types.ObjectId }],
  listingCount: { type: Number, default: 0 },
  note:         { type: String, default: '' },
  batchId:      { type: String, index: true },   // shared ID for listings moved in one action
  timestamp:    { type: Date, default: Date.now }
});

ReviewAssignmentSchema.index({ timestamp: -1 });
ReviewAssignmentSchema.index({ assignedTo: 1, timestamp: -1 });
ReviewAssignmentSchema.index({ 'listings': 1 });

let _model = null;
module.exports = {
  schema: ReviewAssignmentSchema,
  init: (db) => { _model = db.model('ReviewAssignment', ReviewAssignmentSchema); return _model; },
  get model() { return _model; }
};
