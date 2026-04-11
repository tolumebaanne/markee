const registerOrderEvents        = require('./orderEvents');
const registerShipmentEvents     = require('./shipmentEvents');
const registerPaymentEvents      = require('./paymentEvents');
const registerUserEvents         = require('./userEvents');
const registerSellerEvents       = require('./sellerEvents');
const registerRealtimeForwarding = require('./realtimeForwarding');

function registerEvents(bus, services, io) {
    registerOrderEvents(bus, services);
    registerShipmentEvents(bus, services);
    registerPaymentEvents(bus, services);
    registerUserEvents(bus, services);
    registerSellerEvents(bus, services);
    registerRealtimeForwarding(bus, io);
    services.logger.info('All event bus listeners registered');
}

module.exports = registerEvents;
