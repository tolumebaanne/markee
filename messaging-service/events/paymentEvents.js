module.exports = function registerPaymentEvents(bus, services) {
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

    bus.on('payment.disputed', async (payload) => {
        try {
            const { orderId, buyerId } = payload;
            if (!orderId || !buyerId) return;

            let sellerIds = [];
            try {
                const url    = `${process.env.PAYMENT_SERVICE_URL}/escrow/${orderId}`;
                const escRes = await fetch(url);
                if (escRes.ok) {
                    const esc = await escRes.json();
                    sellerIds = (esc.sellerPayouts || [])
                        .map(p => p.sellerId?.toString())
                        .filter(Boolean);
                }
            } catch (fetchErr) {
                logger.error('payment.disputed: failed to fetch escrow data:', fetchErr.message);
            }

            for (const rawSellerId of sellerIds) {
                const sellerId = identityService.resolve(rawSellerId);
                const thread   = await threadService.findThreadByContext(
                    buyerId.toString(), sellerId, 'order', orderId
                );
                if (!thread) continue;

                await Thread.updateOne({ _id: thread._id }, { $set: { priority: 'urgent' } });
                if (io) io.to(`thread:${thread._id}`).emit('thread_updated', { priority: 'urgent' });

                const shortId = orderId.toString().slice(-8).toUpperCase();
                const body    = `A payment dispute has been raised for order #${shortId}. This conversation has been flagged for review. An admin will respond shortly.`;
                const participantIds = thread.participants.map(p => p.toString());
                await injectSystemMessage(thread._id, body, participantIds);
            }
        } catch (err) {
            logger.error('payment.disputed handler error:', err.message);
        }
    });
};
