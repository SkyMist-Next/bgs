'use strict';
const { create } = require('../utils/realm-schema');
module.exports = {
    async up(queryInterface) {
        await create(queryInterface, 'RealmProcessOwner');
        await create(queryInterface, 'RealmProcessPermit');
    },
    async down() { throw new Error('Process permits require an explicit data-preserving rollback'); }
};
