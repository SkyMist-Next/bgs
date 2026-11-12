'use strict';

module.exports = {
    async up(q, T) {
        const id = () => ({ type: T.BIGINT, allowNull: false });
        const generation = () => ({ type: T.BIGINT.UNSIGNED, allowNull: false });
        const session = () => ({ type: T.STRING(80), allowNull: false });
        const group = () => ({ type: T.STRING(36), allowNull: false });
        const date = () => ({ type: T.DATE(3), allowNull: false });
        const options = { engine: 'InnoDB' };
        await q.createTable('social_legacy_owners', {
            game_account_id: { ...id(), primaryKey: true }, account_id: id(), session_key: session(), generation: generation(),
            route: { type: T.JSON, allowNull: false }, object_id: generation(), active: { type: T.BOOLEAN, allowNull: false }, updated_at: date()
        }, options);
        await q.addIndex('social_legacy_owners', ['account_id', 'game_account_id']);
        await q.createTable('social_legacy_claims', {
            game_account_id: { ...id(), primaryKey: true }, session_key: { ...session(), primaryKey: true },
            account_id: id(), generation: generation(), route: { type: T.JSON, allowNull: false }, created_at: date()
        }, options);
        await q.addIndex('social_legacy_claims', ['created_at', 'game_account_id']);
        await q.createTable('social_legacy_groups', { id: { ...group(), primaryKey: true }, created_at: date() }, options);
        await q.createTable('social_legacy_members', {
            group_id: { ...group(), primaryKey: true }, game_account_id: { ...id(), primaryKey: true }, account_id: id(),
            session_key: session(), generation: generation(), joined_at: date()
        }, options);
        await q.addIndex('social_legacy_members', ['game_account_id', 'session_key', 'generation', 'group_id'], { name: 'social_legacy_members_owner' });
        await q.createTable('social_legacy_closed', {
            group_id: { ...group(), primaryKey: true }, game_account_id: { ...id(), primaryKey: true }, account_id: id(),
            session_key: session(), generation: generation(), peer_game_account_id: { type: T.BIGINT, allowNull: true },
            peer_account_id: { type: T.BIGINT, allowNull: true }, created_at: date()
        }, options);
        await q.addIndex('social_legacy_closed', ['game_account_id', 'session_key', 'generation'], { name: 'social_legacy_closed_owner' });
        await q.createTable('social_legacy_mutations', {
            account_id: { ...id(), primaryKey: true }, operation_id: { type: T.CHAR(64), allowNull: false, primaryKey: true },
            request_hash: { type: T.CHAR(64), allowNull: false }, result: { type: T.JSON, allowNull: false }, created_at: date()
        }, options);
    },
    async down(q) {
        for (const table of ['social_legacy_mutations', 'social_legacy_closed', 'social_legacy_members',
            'social_legacy_groups', 'social_legacy_claims', 'social_legacy_owners']) { await q.dropTable(table); }
    }
};
