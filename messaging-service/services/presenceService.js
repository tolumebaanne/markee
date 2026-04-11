class PresenceService {
    constructor(logger) {
        this.map = new Map();
        this.logger = logger;
    }

    setOnline(userId) {
        this.map.set(userId.toString(), { online: true, lastSeenAt: new Date() });
    }

    setOffline(userId) {
        this.map.set(userId.toString(), { online: false, lastSeenAt: new Date() });
    }

    isOnline(userId) {
        return this.map.get(userId?.toString()) || { online: false, lastSeenAt: null };
    }

    getStatus(userId) {
        return this.isOnline(userId);
    }
}

module.exports = PresenceService;
