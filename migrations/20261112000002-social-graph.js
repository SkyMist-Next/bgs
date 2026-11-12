'use strict';

const fs = require('node:fs');
const path = require('node:path');

module.exports = {
    async up(q) {
        // Additive and rerunnable after an interrupted MariaDB DDL sequence.
        const sql = fs.readFileSync(path.join(__dirname, 'sql/social-graph.sql'), 'utf8');
        for (const statement of sql.replace(/^--.*$/gm, '').split(';').map(value => value.trim()).filter(Boolean)) {
            await q.sequelize.query(statement);
        }
    },
    async down() { throw new Error('Social migration is additive; retain friendships, reports, receipts and outbox on rollback'); }
};
