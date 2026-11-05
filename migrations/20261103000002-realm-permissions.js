'use strict';
const { create } = require('../utils/realm-schema');
module.exports = {
    async up(queryInterface) {
        await create(queryInterface, 'GameAccountPermission');
    },
    async down() { throw new Error('Account permission rollback requires preserving existing grants and denials'); }
};
