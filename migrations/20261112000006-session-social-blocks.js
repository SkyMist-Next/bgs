'use strict';

module.exports = {
    async up(q) {
        // No wall-clock TTL: a temporary social outage must not lift a block on a still-live session.
        // Runtime cleanup consults the authenticated connection/world owner before removing a row.
        await q.sequelize.query(`CREATE TABLE IF NOT EXISTS social_session_blocks (
            id VARCHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL PRIMARY KEY,
            session_key VARCHAR(80) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
            account_id BIGINT NOT NULL,
            blocked_account_id BIGINT NOT NULL,
            route JSON NOT NULL,
            created_at DATETIME(3) NOT NULL,
            UNIQUE KEY social_session_block_identity (session_key, blocked_account_id),
            KEY social_session_block_owner (account_id),
            CONSTRAINT social_session_block_account FOREIGN KEY (account_id) REFERENCES accounts(id),
            CONSTRAINT social_session_block_target FOREIGN KEY (blocked_account_id) REFERENCES accounts(id),
            CONSTRAINT social_session_block_distinct CHECK (account_id <> blocked_account_id)
        ) ENGINE=InnoDB`);
    },
    async down() { throw new Error('Retain session blocks until authenticated session cleanup'); }
};
