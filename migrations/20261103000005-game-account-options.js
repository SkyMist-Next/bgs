'use strict';
const { DataTypes } = require('sequelize');
module.exports = {
    async up(queryInterface) {
        await queryInterface.createTable('game_account_options', {
            game_account_id: { type: DataTypes.BIGINT, primaryKey: true, allowNull: false },
            options: { type: DataTypes.JSON, allowNull: false }
        }, { engine: 'InnoDB', charset: 'utf8mb4', collate: 'utf8mb4_bin' });
    },
    async down() { throw new Error('Account options require an explicit data-preserving rollback'); }
};
