const mongoose = require('mongoose');

/**
 * PlatformConfig — singleton document, key/value store for platform-wide flags.
 * Access via PlatformConfig.model.getSingleton() — creates on first access.
 */
const PlatformConfigSchema = new mongoose.Schema({
  _singleton: { type: String, default: 'global', unique: true },

  // ── Platform state ────────────────────────────────────────────────────────────
  maintenanceMode: { type: Boolean, default: false },  // reads allowed, writes return 503
  lockdownMode:    { type: Boolean, default: false },  // all non-admin traffic blocked

  // ── Feature flags ─────────────────────────────────────────────────────────────
  flags: {
    buyerReviewsEnabled:    { type: Boolean, default: true },
    sellerRegistrationOpen: { type: Boolean, default: true },
    guestCheckoutEnabled:   { type: Boolean, default: true },
    codEnabled:             { type: Boolean, default: true },     // cash-on-delivery
    searchAutocompleteLive: { type: Boolean, default: true },
    analyticsPublic:        { type: Boolean, default: false },    // public platform stats
    messagingEnabled:       { type: Boolean, default: true },
    notificationsEnabled:   { type: Boolean, default: true },
    sellerTierBadges:       { type: Boolean, default: true }
  },

  // ── Platform limits ───────────────────────────────────────────────────────────
  limits: {
    maxProductsPerStore:  { type: Number, default: 500 },
    maxImagesPerProduct:  { type: Number, default: 10 },
    maxOrderItemCount:    { type: Number, default: 50 },
    reviewMinPurchaseDays:{ type: Number, default: 7 }
  },

  // ── Audit ─────────────────────────────────────────────────────────────────────
  updatedAt: { type: Date, default: Date.now },
  updatedBy: { type: mongoose.Schema.Types.ObjectId, default: null }
});

PlatformConfigSchema.statics.getSingleton = async function () {
  let doc = await this.findOne({ _singleton: 'global' });
  if (!doc) doc = await this.create({ _singleton: 'global' });
  return doc;
};

let _model = null;
module.exports = {
  schema: PlatformConfigSchema,
  init: (db) => { _model = db.model('PlatformConfig', PlatformConfigSchema); return _model; },
  get model() { return _model; }
};
