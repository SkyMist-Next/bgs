'use strict';

module.exports = {
  up: (queryInterface, Sequelize) => {
      return queryInterface.addColumn('game_accounts', 'expansion', {
          type: Sequelize.TINYINT,
          allowNull: false,
          defaultValue: 6
      });
  },

  down: (queryInterface) => {
    return queryInterface.removeColumn('game_accounts', 'expansion');
  }
};
