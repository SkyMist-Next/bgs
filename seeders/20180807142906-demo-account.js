'use strict';

module.exports = {
    async up(queryInterface, Sequelize) {
        const sql = queryInterface.sequelize;
        const Account = sql.models.Account || require('../models/account')(sql, Sequelize.DataTypes);
        const GameAccount = sql.models.GameAccount || require('../models/gameaccount')(sql, Sequelize.DataTypes);
        await sql.transaction(async transaction => {
            const account = await Account.create({
                email: 'demo@demo', hash: '$2a$08$CSJ8s.ENXLbXKTUkrqHl8.eIco754jefMnqoxPeQJoaaKfQdfSArq', battleTag: '#11111'
            }, { transaction });
            for (const displayName of ['WoW 1', 'WoW 2']) {
                await GameAccount.create({ accountId: account.id, region: 2, program: 'WoW', displayName }, { transaction });
            }
        });
    },
    async down() { throw new Error('Demo account deletion requires an explicit scoped operation'); }
};
