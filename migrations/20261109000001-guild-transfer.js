'use strict';
const fs = require('node:fs');
const path = require('node:path');
module.exports = {
    async up(q) {
        // This file contains DDL only, with no procedures, delimiters or string semicolons.
        const sql = fs.readFileSync(path.join(__dirname, 'sql/guild-transfer.sql'), 'utf8');
        for (const statement of sql.replace(/^--.*$/gm, '').split(';').map(value => value.trim()).filter(Boolean)) {
            await q.sequelize.query(statement);
        }
    },
    async down() { throw new Error('Guild transfer journals and receipts must be retained'); }
};
