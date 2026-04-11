module.exports = function sendMessageHandler(socket, io, services) {
    const { threadService, messageService, identityService,
            rateLimiter, logger, bus, Thread, Message } = services;
    const userId = socket.user.sub;

    socket.on('send_message', async (data) => {
        try {
            // 1. Rate limit
            if (!rateLimiter.check(userId)) {
                socket.emit('rate_limited', { error: 'Too many messages. Slow down.' });
                return;
            }

            // 2. Validate
            const { recipientId, body, contextType, refId, refTitle, refImage,
                    attachmentUrl, attachmentType } = data || {};
            if (!recipientId) {
                socket.emit('message_error', { error: 'recipientId required' });
                return;
            }
            if (!body && !attachmentUrl) {
                socket.emit('message_error', { error: 'body or attachment required' });
                return;
            }

            // 3. Resolve identity (storeId → userId if needed)
            const resolvedRecipient = identityService.resolve(recipientId);

            // 4. Find or create thread
            const thread = await threadService.findOrCreate(
                userId, resolvedRecipient,
                { type: contextType || 'general', refId, refTitle, refImage },
                socket.user.displayName || '',
                ''
            );

            // 5. Check suspended
            if (thread.admin?.suspended) {
                socket.emit('message_error', { error: 'This conversation has been suspended by an administrator.' });
                return;
            }

            // 6. Authoritative recipient from DB (NEVER trust client)
            const authRecipientId = thread.participants
                .map(p => p.toString())
                .find(p => p !== userId);
            if (!authRecipientId) {
                socket.emit('message_error', { error: 'Cannot determine recipient.' });
                return;
            }

            // 7. Create message
            const msg = await messageService.create({
                threadId:       thread._id,
                senderId:       userId,
                recipientId:    authRecipientId,
                type:           attachmentUrl ? 'attachment' : 'text',
                body:           body || '',
                attachment:     attachmentUrl ? { url: attachmentUrl, type: attachmentType || 'image' } : undefined
            });

            // 8. Update thread denormalized fields
            const preview = (body || attachmentUrl || '').slice(0, 80);
            await threadService.incrementUnread(thread._id, authRecipientId, preview, msg.type, msg.createdAt);

            // 9. Delivery
            const recipientRoom   = io.sockets.adapter.rooms.get(authRecipientId);
            const recipientOnline = recipientRoom && recipientRoom.size > 0;
            const msgObj          = msg.toObject();

            if (recipientOnline) {
                msgObj.status = { ...msgObj.status, deliveredAt: new Date() };
                await Message.updateOne({ _id: msg._id }, { $set: { 'status.deliveredAt': new Date() } });
                socket.to(authRecipientId).emit('new_message', msgObj);
                socket.emit('message_delivered', { messageId: msg._id, deliveredAt: msgObj.status.deliveredAt });
            } else {
                socket.to(authRecipientId).emit('new_message', msgObj);
                bus.emit('message.unread', {
                    recipientId: authRecipientId,
                    senderId:    userId,
                    senderName:  socket.user.displayName || '',
                    threadId:    thread._id.toString(),
                    preview
                });
            }

            // 10. Sender confirmation + multi-tab (exclude recipient — they got it above)
            socket.emit('message_sent', msgObj);
            socket.to(`thread:${thread._id}`).except(authRecipientId).emit('new_message', msgObj);

            // 11. Analytics: seller response time
            try {
                const isSeller = socket.user.storeActive === true || socket.user.role === 'seller';
                if (isSeller) {
                    const freshThread = await Thread.findById(thread._id);
                    if (freshThread && freshThread.messageCount === 2) {
                        const firstMsg = await Message.findOne({ threadId: thread._id, type: 'text' }).sort({ createdAt: 1 });
                        if (firstMsg && firstMsg.senderId?.toString() !== userId) {
                            const responseTimeMs = Date.now() - new Date(firstMsg.createdAt).getTime();
                            bus.emit('message.seller_response', {
                                sellerId:     userId,
                                threadId:     thread._id.toString(),
                                responseTimeMs,
                                contextType:  freshThread.context?.type || 'general'
                            });
                        }
                    }
                }
            } catch (_) { /* analytics never blocks delivery */ }

        } catch (err) {
            logger.error('send_message error:', err.message);
            socket.emit('message_error', { error: 'Message failed: ' + err.message });
        }
    });
};
