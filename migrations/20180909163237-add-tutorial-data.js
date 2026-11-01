'use strict';

module.exports = {
    up: (queryInterface, Sequelize) => {
        return queryInterface.addColumn('game_accounts', 'tutorial_data', {
            type: Sequelize.BLOB('tiny'),
            allowNull: true
        });
    },

    down: (queryInterface) => {
        return queryInterface.removeColumn('game_accounts', 'tutorial_data');
    }
};
