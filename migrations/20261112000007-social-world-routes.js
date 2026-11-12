'use strict';

module.exports = {
    async up(q) {
        // The fence outlives subscriptions: delayed Subscribe calls cannot revive an old queue.
        // Only authenticated session loss permits cleanup, never an elapsed social timeout.
        await q.sequelize.query(`CREATE TABLE IF NOT EXISTS social_world_routes (
            id VARCHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL PRIMARY KEY,
            session_key VARCHAR(80) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
            account_id BIGINT NOT NULL,
            game_account_id BIGINT NOT NULL,
            route_epoch BIGINT UNSIGNED NOT NULL,
            route JSON NOT NULL,
            UNIQUE KEY social_world_route_session (session_key),
            KEY social_world_route_account (account_id),
            CONSTRAINT social_world_route_account_fk FOREIGN KEY (account_id) REFERENCES accounts(id),
            CONSTRAINT social_world_route_positive_epoch CHECK (route_epoch > 0)
        ) ENGINE=InnoDB`);
        // Bound distinct parent targets efficiently even when many licenses block the same peer.
        await q.sequelize.query(`ALTER TABLE social_session_blocks
            ADD INDEX IF NOT EXISTS social_session_block_parent_target (account_id, blocked_account_id)`);
    },
    async down() { throw new Error('Retain world route fences until authenticated session cleanup'); }
};
