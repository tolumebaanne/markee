const RATE_MAX = 20;
const RATE_WINDOW = 60 * 1000;

class RateLimiter {
    constructor() {
        this.map = new Map();
        this._cleanup = setInterval(() => {
            const now = Date.now();
            for (const [key, entry] of this.map) {
                if (now - entry.windowStart > RATE_WINDOW * 2) {
                    this.map.delete(key);
                }
            }
        }, 5 * 60 * 1000);
    }

    check(userId) {
        const now = Date.now();
        const entry = this.map.get(userId);
        if (!entry || now - entry.windowStart > RATE_WINDOW) {
            this.map.set(userId, { count: 1, windowStart: now });
            return true;
        }
        if (entry.count >= RATE_MAX) return false;
        entry.count++;
        return true;
    }

    destroy() {
        clearInterval(this._cleanup);
        this.map.clear();
    }
}

function createRateLimiter() {
    return new RateLimiter();
}

module.exports = createRateLimiter;
