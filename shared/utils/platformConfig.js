/**
 * shared/utils/platformConfig.js
 *
 * Shared PlatformConfig helper — usable from any service.
 * Creates its own mongoose connection to the platformconfigs collection.
 * Caches result for 5 minutes to avoid hammering the DB on every request.
 *
 * Usage:
 *   const { getPlatformConfig } = require('../shared/utils/platformConfig');
 *   const cfg = await getPlatformConfig();
 *   console.log(cfg.defaultCurrency); // 'cad'
 */

'use strict';

const mongoose = require('mongoose');

const PlatformConfigSchema = new mongoose.Schema({
    platformFeePercent:    { type: Number, default: 0 },
    disputeWindowHours:    { type: Number, default: 48 },
    sellerAcceptanceHours: { type: Number, default: 24 },
    codExpiryDays:         { type: Number, default: 7 },
    defaultCurrency:       { type: String, default: 'cad' },
    taxRates:              { type: Map, of: Number, default: {} },
    updatedAt:             { type: Date, default: Date.now },
}, { collection: 'platformconfigs' });

// Lazy connection — only created when getPlatformConfig() is first called
let _sharedDb      = null;
let _PlatformConfig = null;

function getModel() {
    if (_PlatformConfig) return _PlatformConfig;
    if (!process.env.MONGODB_URI) {
        throw new Error('MONGODB_URI is not set — cannot load PlatformConfig');
    }
    _sharedDb      = mongoose.createConnection(process.env.MONGODB_URI);
    _PlatformConfig = _sharedDb.model('PlatformConfig', PlatformConfigSchema);
    return _PlatformConfig;
}

// Module-level cache
let _cache     = null;
let _cacheTime = 0;
const TTL_MS   = 5 * 60 * 1000; // 5 minutes

/**
 * Return the PlatformConfig document. Creates one from env vars if absent.
 * Cached for 5 minutes.
 */
async function getPlatformConfig() {
    const now = Date.now();
    if (_cache && (now - _cacheTime) < TTL_MS) return _cache;

    const Model = getModel();
    let cfg = await Model.findOne({});
    if (!cfg) {
        cfg = await Model.create({
            platformFeePercent:    parseFloat(process.env.PLATFORM_FEE_PERCENT  || '0'),
            disputeWindowHours:    parseInt(process.env.DISPUTE_WINDOW_HOURS    || '48', 10),
            sellerAcceptanceHours: parseInt(process.env.SELLER_ACCEPTANCE_HOURS || '24', 10),
            codExpiryDays:         parseInt(process.env.COD_EXPIRY_DAYS         || '7',  10),
            defaultCurrency:       (process.env.DEFAULT_CURRENCY                || 'cad').toLowerCase(),
        });
    }
    _cache     = cfg;
    _cacheTime = now;
    return cfg;
}

/** Invalidate the shared cache — call after admin updates the config. */
function invalidatePlatformConfigCache() {
    _cache     = null;
    _cacheTime = 0;
}

module.exports = { getPlatformConfig, invalidatePlatformConfigCache, getPlatformConfigModel: getModel };
