'use strict';
const { DataTypes } = require('sequelize');

module.exports = {
    async up(q) {
        for (const [name, value] of [['credential_version', 1], ['authenticator_generation', 0], ['authenticator_state', 0]]) {
            if (!(await q.describeTable('accounts'))[name]) {
                await q.addColumn('accounts', name, { type: DataTypes.BIGINT, allowNull: false, defaultValue: value });
            }
        }
        await q.sequelize.query(`CREATE TABLE IF NOT EXISTS account_authenticators (
            account_id BIGINT NOT NULL PRIMARY KEY, generation BIGINT NOT NULL,
            sealed_secret VARBINARY(49) NOT NULL, pending_expires BIGINT NOT NULL DEFAULT 0,
            last_step BIGINT NULL, failed_attempts TINYINT UNSIGNED NOT NULL DEFAULT 0,
            blocked_until BIGINT NOT NULL DEFAULT 0,
            CONSTRAINT authenticator_parent FOREIGN KEY(account_id) REFERENCES accounts(id) ON DELETE CASCADE,
            CHECK(generation>0), CHECK(OCTET_LENGTH(sealed_secret)=49), CHECK(failed_attempts<=5)
        ) ENGINE=InnoDB`);
        await q.sequelize.query(`CREATE TRIGGER IF NOT EXISTS accounts_credential_change BEFORE UPDATE ON accounts FOR EACH ROW
            BEGIN
                IF NOT (BINARY NEW.hash <=> BINARY OLD.hash) THEN SET NEW.credential_version=OLD.credential_version+1; END IF;
                IF NEW.credential_version<OLD.credential_version OR NEW.credential_version<=0 OR
                    NEW.authenticator_generation<OLD.authenticator_generation OR NEW.authenticator_state NOT IN (0,1,2) THEN
                    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='Invalid authentication generation';
                END IF;
            END`);
    },
    async down() { throw new Error('Authenticator rollback must preserve enrollments and credential generations'); }
};
