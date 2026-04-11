module.exports = function registerSellerEvents(bus, services) {
    // IdentityService already listens to store.verified, store.updated,
    // seller.reactivated, seller.deactivated in its constructor.
    // No additional handling needed here.
    services.logger.info('Seller events: handled by IdentityService');
};
