module.exports = function registerRealtimeForwarding(bus, io) {
    bus.on('payment.captured', (p) => {
        if (p.sellerId) io.to(p.sellerId).emit('order.new', { orderId: p.orderId, buyerId: p.buyerId });
    });
    bus.on('order.status_updated', (p) => {
        if (p.buyerId) io.to(p.buyerId).emit('order.status', { orderId: p.orderId, status: p.status });
    });
    bus.on('shipment.created', (p) => {
        if (p.buyerId) io.to(p.buyerId).emit('shipment.new', { orderId: p.orderId, trackingNumber: p.trackingNumber, carrier: p.carrier });
    });
    bus.on('shipment.delivered', (p) => {
        if (p.buyerId) io.to(p.buyerId).emit('shipment.delivered', { orderId: p.orderId });
    });
    bus.on('inventory.stock_low', (p) => {
        if (p.sellerId) io.to(p.sellerId).emit('stock.low', { productId: p.productId, quantity: p.quantity });
    });
};
