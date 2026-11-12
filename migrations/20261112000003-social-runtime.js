'use strict';

module.exports = {
    async up(q, T) {
        await q.createTable('social_subscriptions', {
            id: { type: T.STRING(36), primaryKey: true },
            session_key: { type: T.STRING(80), allowNull: false },
            account_id: { type: T.BIGINT, allowNull: false },
            game_account_id: { type: T.BIGINT, allowNull: true },
            kind: { type: T.STRING(32), allowNull: false },
            target: { type: T.STRING(64), allowNull: false },
            object_id: { type: T.BIGINT.UNSIGNED, allowNull: false },
            route: { type: T.JSON, allowNull: false },
            filter: { type: T.JSON, allowNull: false },
            snapshot: { type: T.JSON, allowNull: true },
            ready: { type: T.BOOLEAN, allowNull: false, defaultValue: false },
            expires_at: { type: T.DATE, allowNull: false }
        });
        await q.addIndex('social_subscriptions', ['session_key', 'kind', 'target', 'object_id'], { unique: true, name: 'social_subscription_identity' });
        await q.addIndex('social_subscriptions', ['kind', 'id']);
        await q.addIndex('social_subscriptions', ['account_id', 'kind']);
        await q.addIndex('social_subscriptions', ['expires_at']);
    },
    async down(q) { await q.dropTable('social_subscriptions'); }
};
