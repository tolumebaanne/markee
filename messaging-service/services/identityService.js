const logger = require('../utils/logger');

class IdentityService {
    constructor(bus) {
        this.cache = new Map();      // storeId → sellerId
        this.nameCache = new Map();  // storeId → storeName
        this.bus = bus;
        this.ready = false;

        bus.on('store.verified',     (p) => this._set(p));
        bus.on('store.updated',      (p) => this._set(p));
        bus.on('seller.reactivated', (p) => this._set(p));
        bus.on('seller.deactivated', (p) => this._set(p));
    }

    async warmup(timeoutMs = 5000) {
        return new Promise((resolve) => {
            const timer = setTimeout(() => {
                this.ready = true;
                logger.info(`Identity cache warm — ${this.cache.size} stores cached (timeout path)`);
                resolve();
            }, timeoutMs);

            this.bus.once('store_sync.complete', () => {
                clearTimeout(timer);
                this.ready = true;
                logger.info(`Identity cache warm — ${this.cache.size} stores cached (sync complete)`);
                resolve();
            });

            this.bus.emit('request.store_sync');
        });
    }

    resolve(id) {
        if (!id) return null;
        const key = id.toString();
        return this.cache.get(key) || key;
    }

    getStoreName(id) {
        if (!id) return '';
        // Try by storeId first, then by sellerId (reverse lookup)
        const byStore = this.nameCache.get(id.toString());
        if (byStore) return byStore;
        // Reverse: if id is a sellerId, find the store name
        for (const [storeId, sellerId] of this.cache) {
            if (sellerId === id.toString()) {
                return this.nameCache.get(storeId) || '';
            }
        }
        return '';
    }

    _set(payload) {
        if (payload && payload.storeId && payload.sellerId) {
            this.cache.set(payload.storeId.toString(), payload.sellerId.toString());
            if (payload.storeName) {
                this.nameCache.set(payload.storeId.toString(), payload.storeName);
            }
        }
    }
}

module.exports = IdentityService;
