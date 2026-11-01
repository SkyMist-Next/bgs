'use strict';

module.exports = {
    up: (queryInterface, Sequelize) => {
        return queryInterface.addColumn('game_accounts', 'account_id', {
            type: Sequelize.BIGINT,
            allowNull: false
        }).then(() => {
            return queryInterface.addConstraint('game_accounts', ['account_id'], {
                type: 'foreign key',
                name: 'account_key',
                references: {
                    table: 'accounts',
                    field: 'id'
                },
                onDelete: 'cascade',
                onUpdate: 'cascade'
            });
        });
    },

    down: (queryInterface) => {
        return queryInterface.removeColumn('game_accounts', 'account_id');
    }
};
