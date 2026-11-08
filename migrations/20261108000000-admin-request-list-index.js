'use strict';

// Additive and idempotent: preserve journals and the index on application rollback.
module.exports = {
    async up(q) {
        const name = 'admin_requests_actor_created_request';
        const indexes = await q.showIndex('admin_requests');
        if (!indexes.some(index => index.name === name)) {
            await q.addIndex('admin_requests', ['actor', 'created_at', 'request_id'], { name });
        }
    },
    async down() {
        throw new Error('Retain administration journal index on rollback');
    }
};
