/**
 * processDeletions — scheduled job
 *
 * Runs hourly. Finds all users with status 'pending_deletion' whose
 * 24-hour cooldown window has elapsed and finalises the soft-delete:
 *   1. Stores the real email in originalEmail
 *   2. Mangles the email to release it from the unique index
 *   3. Sets status to 'deleted' with a deletedAt timestamp
 *   4. Emits user.self_deleted so user-service marks the profile
 *
 * originalEmail is intentionally NOT included in the event payload —
 * PII stays inside auth-service's DB only.
 */

const User = require('../models/User');
const bus  = require('../../shared/eventBus');

const COOLDOWN_MS = 24 * 60 * 60 * 1000; // 24 hours

async function processDeletions() {
    const cutoff = new Date(Date.now() - COOLDOWN_MS);
    const pending = await User.find({
        status: 'pending_deletion',
        pendingDeletionSince: { $lte: cutoff }
    });

    if (!pending.length) return;
    console.log(`[AUTH:JOB] Processing ${pending.length} pending deletion(s)`);

    for (const user of pending) {
        try {
            user.originalEmail        = user.email;
            user.email                = `__deleted_${user._id}_${Date.now()}`;
            user.status               = 'deleted';
            user.deletedAt            = new Date();
            user.pendingDeletionSince = undefined;
            await user.save();

            bus.emit('user.self_deleted', {
                userId:    user._id.toString(),
                storeId:   user.storeId.toString(),
                deletedAt: user.deletedAt
                // originalEmail intentionally omitted — never travels on bus
            });

            console.log(`[AUTH:JOB] Soft-deleted userId ${user._id}`);
        } catch (err) {
            console.error(`[AUTH:JOB] Failed to finalise deletion for userId ${user._id}:`, err.message);
        }
    }
}

module.exports = { processDeletions };
