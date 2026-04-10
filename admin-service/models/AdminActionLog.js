const mongoose = require('mongoose');

const AdminActionLogSchema = new mongoose.Schema({
  adminId:     { type: mongoose.Schema.Types.ObjectId, required: true, index: true },
  isSuperuser: { type: Boolean, default: false },
  sessionId:   { type: String, default: null },

  // What was done
  action:       { type: String, required: true },     // e.g. 'account.suspend', 'order.forceStatus'
  resource:     { type: String, default: null },      // e.g. 'AdminAccount', 'Order'
  resourceId:   { type: String, default: null },      // target document _id
  service:      { type: String, default: null },      // e.g. 'order-service'
  method:       { type: String, default: null },      // HTTP method of originating request
  path:         { type: String, default: null },      // endpoint path
  statusCode:   { type: Number, default: null },

  // Payload snapshot — before and after for destructive ops
  before: { type: mongoose.Schema.Types.Mixed, default: null },
  after:  { type: mongoose.Schema.Types.Mixed, default: null },
  params: { type: mongoose.Schema.Types.Mixed, default: null },

  reason:    { type: String, default: '' },
  ipAddress: { type: String, default: null },
  timestamp: { type: Date, default: Date.now, index: true }
});

let _model = null;
module.exports = {
  schema: AdminActionLogSchema,
  init: (db) => { _model = db.model('AdminActionLog', AdminActionLogSchema); return _model; },
  get model() { return _model; }
};
