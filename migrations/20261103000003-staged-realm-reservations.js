'use strict';
const { DataTypes } = require('sequelize');
const { create } = require('../utils/realm-schema');

module.exports = {
    async up(queryInterface) {
        await queryInterface.changeColumn('game_account_reservations', 'status', { type: DataTypes.ENUM('staging', 'prepared', 'committed', 'aborted'), allowNull: false, defaultValue: 'prepared' });
        const columns = await queryInterface.describeTable('game_account_reservations');
        for (const name of ['expected_changes', 'expected_chunks']) {
            if (!columns[name]) { await queryInterface.addColumn('game_account_reservations', name, { type: DataTypes.INTEGER.UNSIGNED, allowNull: false, defaultValue: 0 }); }
        }
        await create(queryInterface, 'GameAccountReservationChunk');
    },
    async down() { throw new Error('Staged reservations require an explicit data-preserving rollback'); }
};
