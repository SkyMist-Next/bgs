'use strict';

module.exports = {
    up: (queryInterface, Sequelize) => {
        return queryInterface.addColumn('game_accounts', 'billing_plan', {
            type: Sequelize.TINYINT.UNSIGNED,
            allowNull: true,
            defaultValue: 0
        }).then(() => {
            return queryInterface.addColumn('game_accounts', 'billing_time_remaining', {
                type: Sequelize.INTEGER.UNSIGNED,
                allowNull: true,
                defaultValue: 0
            });
        })
    },

    down: (queryInterface) => {
        return queryInterface.removeColumn('game_accounts', 'billing_plan').then(() => {
            return queryInterface.removeColumn('game_accounts', 'billing_time_remaining');
        });
    }
};
