module.exports = function registerOrderEvents(bus, services) {
    const { Thread, Message, threadService, messageService, identityService, logger, io } = services;

    async function injectSystemMessage(threadId, body, participantIds) {
        // recipientId for system messages is the first participant (doesn't matter — it's informational)
        const recipientId = participantIds[0];
        const msg = await messageService.create({
            threadId,
            senderId:    null,
            recipientId,
            type:        'system',
            body
        });
        // Emit to thread room so all connected participants see it
        if (io) {
            io.to(`thread:${threadId}`).emit('new_message', msg.toObject ? msg.toObject() : msg);
        }
        return msg;
    }

    // order.placed — create thread + inject system message
    bus.on('order.placed', async (payload) => {
        try {
            const { orderId, buyerId, sellerIds, items, totalAmount } = payload;
            if (!orderId || !buyerId || !Array.isArray(sellerIds) || !sellerIds.length) return;

            for (const rawSellerId of sellerIds) {
                const sellerId = identityService.resolve(rawSellerId);
                const shortId  = orderId.toString().slice(-8).toUpperCase();

                const thread = await threadService.findOrCreate(
                    buyerId.toString(),
                    sellerId,
                    { type: 'order', refId: orderId, refTitle: `Order #${shortId}`, refImage: '' },
                    '',
                    ''
                );

                const sellerItems = (items || []).filter(i => i.sellerId?.toString() === rawSellerId.toString());
                const itemCount   = sellerItems.length || (items || []).length;
                const total       = totalAmount ? ` — Total: $${(totalAmount / 100).toFixed(2)}` : '';
                const body        = `Order #${shortId} placed${total}. ${itemCount} item${itemCount !== 1 ? 's' : ''}.`;

                const participantIds = thread.participants.map(p => p.toString());
                await injectSystemMessage(thread._id, body, participantIds);
            }
        } catch (err) {
            logger.error('order.placed handler error:', err.message);
        }
    });

    // order.status_updated — inject status message + escalate urgent
    bus.on('order.status_updated', async (payload) => {
        try {
            const { orderId, status, buyerId, sellerIds } = payload;
            if (!orderId || !buyerId) return;

            const STATUS_MESSAGES = {
                cancelled:        'This order has been cancelled.',
                refund_requested: 'A refund has been requested for this order.',
                disputed:         'A dispute has been opened for this order.',
                shipped:          'Your order is now shipped.',
                delivered:        'Your order has been delivered.'
            };
            const body = STATUS_MESSAGES[status];
            if (!body) return;

            const URGENT   = ['cancelled', 'refund_requested', 'disputed'];
            const sellers  = Array.isArray(sellerIds)
                ? sellerIds.map(id => identityService.resolve(id))
                : [];

            for (const sellerId of sellers) {
                const thread = await threadService.findThreadByContext(
                    buyerId.toString(), sellerId, 'order', orderId
                );
                if (!thread) continue;

                const participantIds = thread.participants.map(p => p.toString());
                await injectSystemMessage(thread._id, body, participantIds);

                if (URGENT.includes(status)) {
                    await Thread.updateOne({ _id: thread._id }, { $set: { priority: 'urgent' } });
                    if (io) io.to(`thread:${thread._id}`).emit('thread_updated', { priority: 'urgent' });
                }
            }
        } catch (err) {
            logger.error('order.status_updated handler error:', err.message);
        }
    });
};
