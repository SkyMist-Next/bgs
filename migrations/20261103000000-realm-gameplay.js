'use strict';
const { DataTypes } = require('sequelize');
const { create } = require('../utils/realm-schema');

module.exports = {
    async up(queryInterface) {
        for (const name of ['RealmRPCOutcome', 'GameAccountSession', 'GameAccountState', 'GameAccountCharacters']) { await create(queryInterface, name); }
        await create(queryInterface, 'GameAccountReservation', { omit: ['expected_changes', 'expected_chunks'],
            overrides: { status: { type: DataTypes.ENUM('prepared', 'committed', 'aborted'), allowNull: false, defaultValue: 'prepared' } } });
        const indexes = await queryInterface.showIndex('game_account_reservations');
        if (!indexes.some(index => index.name === 'pending')) { await queryInterface.addIndex('game_account_reservations', ['realm_uid', 'status', 'request_id'], { name: 'pending' }); }
    },
    async down() { throw new Error('Realm gameplay state requires an explicit data-preserving rollback'); }
};
