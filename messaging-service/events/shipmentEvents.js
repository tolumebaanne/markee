module.exports = function registerShipmentEvents(bus, services) {
    const { Thread, threadService, messageService, identityService, logger, io } = services;

    async function injectSystemMessage(threadId, body, participantIds) {
        const recipientId = participantIds[0];
        const msg = await messageService.create({
            threadId,
            senderId:    null,
            recipientId,
            type:        'system',
            body
        });
        if (io) {
            io.to(`thread:${threadId}`).emit('new_message', msg.toObject ? msg.toObject() : msg);
        }
        return msg;
    }

    // shipment.created — inject shipped message
    bus.on('shipment.created', async (payload) => {
        try {
            const { orderId, buyerId, sellerId: rawSellerId, carrier, trackingNumber } = payload;
            if (!orderId || !buyerId || !rawSellerId) return;
            const sellerId = identityService.resolve(rawSellerId);

            const thread = await threadService.findThreadByContext(
                buyerId.toString(), sellerId, 'order', orderId
            );
            if (!thread) return;

            const tracking = trackingNumber
                ? ` Tracking: ${trackingNumber}${carrier ? ` via ${carrier}` : ''}.`
                : '';
            const participantIds = thread.participants.map(p => p.toString());
            await injectSystemMessage(thread._id, `Your order has shipped!${tracking}`, participantIds);
        } catch (err) {
            logger.error('shipment.created handler error:', err.message);
        }
    });

    // shipment.delivered — inject delivered message + schedule auto-archive
    bus.on('shipment.delivered', async (payload) => {
        try {
            const { orderId, buyerId, sellerId: rawSellerId } = payload;
            if (!orderId || !buyerId || !rawSellerId) return;
            const sellerId = identityService.resolve(rawSellerId);

            const thread = await threadService.findThreadByContext(
                buyerId.toString(), sellerId, 'order', orderId
            );
            if (!thread) return;

            const participantIds = thread.participants.map(p => p.toString());
            await injectSystemMessage(thread._id, 'Order delivered.', participantIds);

            await Thread.updateOne(
                { _id: thread._id },
                { $set: {
                    'autoArchive.pending':     true,
                    'autoArchive.scheduledAt': new Date(Date.now() + 30 * 24 * 60 * 60 * 1000)
                }}
            );
        } catch (err) {
            logger.error('shipment.delivered handler error:', err.message);
        }
    });

    // shipment.status_updated — inject per-status message (skip 'created' — already handled)
    bus.on('shipment.status_updated', async (payload) => {
        try {
            const { orderId, buyerId, sellerId: rawSellerId, status, note, location } = payload;
            if (!orderId || !buyerId || !rawSellerId) return;
            if (status === 'created') return;

            const sellerId = identityService.resolve(rawSellerId);
            const thread   = await threadService.findThreadByContext(
                buyerId.toString(), sellerId, 'order', orderId
            );
            if (!thread) return;

            const STATUS_LABELS = {
                in_transit:       'In transit',
                out_for_delivery: 'Out for delivery',
                delivered:        'Delivered',
                cancelled:        'Shipment cancelled'
            };
            let body = `Shipment update: ${STATUS_LABELS[status] || status}.`;
            if (note)     body += ` ${note}.`;
            if (location) body += ` (${location})`;

            const participantIds = thread.participants.map(p => p.toString());
            await injectSystemMessage(thread._id, body, participantIds);
        } catch (err) {
            logger.error('shipment.status_updated handler error:', err.message);
        }
    });
};
