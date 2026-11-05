'use strict';
const { DataTypes: D } = require('sequelize');
module.exports = {
    async up(queryInterface) {
        await queryInterface.createTable('account_restorations', {
            account_id: { type: D.BIGINT, primaryKey: true, allowNull: false },
            last_restore: { type: D.INTEGER.UNSIGNED, allowNull: false, defaultValue: 0 },
            pending_realm_uid: { type: D.STRING(36), allowNull: true },
            pending_request_id: { type: D.STRING(36), allowNull: true },
            pending_at: { type: D.INTEGER.UNSIGNED, allowNull: false, defaultValue: 0 }
        }, { engine: 'InnoDB', charset: 'ascii', collate: 'ascii_bin' });
    },
    async down() { throw new Error('Restoration outcomes require a data-preserving rollback'); }
};
