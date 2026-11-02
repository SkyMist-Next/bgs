'use strict';

// Additive and resumable: MariaDB DDL commits implicitly. Never erase state on rollback.
async function preflight(q) {
    const [duplicates] = await q.sequelize.query(`SELECT a.id FROM accounts a JOIN
        (SELECT email FROM accounts GROUP BY email HAVING COUNT(*) > 1) duplicates
        ON a.email = duplicates.email ORDER BY a.id`);
    if (duplicates.length) {
        const error = new Error('Duplicate emails under existing collation; resolve account IDs before migration: ' + JSON.stringify(duplicates));
        error.code = 'BGS_EMAIL_CONFLICT';
        throw error;
    }
}

module.exports = {
    preflight,
    async up(q, S) {
        await preflight(q);
        const indexes = await q.showIndex('accounts');
        if (!indexes.some(index => index.name === 'accounts_email_unique')) {
            await q.addIndex('accounts', ['email'], { name: 'accounts_email_unique', unique: true });
        }
        for (const table of ['accounts', 'game_accounts']) {
            const columns = await q.describeTable(table);
            if (!columns.ban_expires_at) { await q.addColumn(table, 'ban_expires_at', { type: S.DATE, allowNull: true }); }
            if (!columns.ban_reason) { await q.addColumn(table, 'ban_reason', { type: S.STRING(1024), allowNull: true }); }
        }
        await q.sequelize.query(`CREATE TABLE IF NOT EXISTS ip_bans (
            id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY, address VARCHAR(45) CHARACTER SET ascii COLLATE ascii_bin NOT NULL UNIQUE,
            expires_at DATETIME(3) NULL, reason VARCHAR(1024) NOT NULL DEFAULT '',
            created_at DATETIME(3) NOT NULL, updated_at DATETIME(3) NOT NULL) ENGINE=InnoDB`);
        await q.sequelize.query(`CREATE TABLE IF NOT EXISTS game_account_privileges (
            game_account_id BIGINT NOT NULL, realm_uid VARCHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL DEFAULT '',
            level TINYINT NOT NULL, updated_at DATETIME(3) NOT NULL,
            PRIMARY KEY(game_account_id, realm_uid), CHECK(level BETWEEN 0 AND 3),
            FOREIGN KEY(game_account_id) REFERENCES game_accounts(id) ON DELETE CASCADE) ENGINE=InnoDB`);
        await q.sequelize.query(`CREATE TABLE IF NOT EXISTS admin_requests (
            request_id VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL PRIMARY KEY,
            fingerprint CHAR(64) CHARACTER SET ascii NOT NULL, actor VARCHAR(128) NOT NULL,
            operation VARCHAR(64) NOT NULL, target JSON NOT NULL, outcome MEDIUMTEXT NULL,
            enforcement_claimed BOOLEAN NOT NULL DEFAULT FALSE,
            created_at DATETIME(3) NOT NULL, updated_at DATETIME(3) NOT NULL) ENGINE=InnoDB`);
        await q.sequelize.query(`CREATE TABLE IF NOT EXISTS admin_audit (
            id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY, request_id VARCHAR(64) NOT NULL,
            actor VARCHAR(128) NOT NULL, operation VARCHAR(64) NOT NULL, target JSON NOT NULL,
            status VARCHAR(16) NOT NULL, code VARCHAR(64) NOT NULL,
            created_at DATETIME(3) NOT NULL, completed_at DATETIME(3) NOT NULL) ENGINE=InnoDB`);
    },
    async down() { throw new Error('Administration migration is additive; rollback code without dropping administration data'); }
};
