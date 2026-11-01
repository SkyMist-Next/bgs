'use strict';

module.exports = {
    up: (queryInterface, Sequelize) => {
        return queryInterface.bulkInsert('accounts', [{
            email: 'demo@demo',
            hash: '$2a$08$CSJ8s.ENXLbXKTUkrqHl8.eIco754jefMnqoxPeQJoaaKfQdfSArq',
            battle_tag: '#11111',
            created_at: new Date(),
            updated_at: new Date()
        }]).then(() => {
            return queryInterface.sequelize.query('SELECT id FROM accounts', { type: Sequelize.QueryTypes.SELECT });
        }).then((accounts) => {
            let account = accounts[0];
            return queryInterface.bulkInsert('game_accounts', [
                { account_id: account.id, region: 2, program: 'WoW', display_name: 'WoW 1', created_at: new Date(), updated_at: new Date()},
                { account_id: account.id, region: 2, program: 'WoW', display_name: 'WoW 2', created_at: new Date(), updated_at: new Date()}
            ])
        });
    },

    down: (queryInterface) => {
        return queryInterface.bulkDelete('accounts', null, {});
    }
};
