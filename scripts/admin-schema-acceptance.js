'use strict';
// Opt-in isolated MariaDB fixture. Invoked by skymist-admin/scripts/mariadb_acceptance.py.
const fs = require('node:fs');
const Sequelize = require('sequelize');
const migration = require('../migrations/20261102000000-administration');
async function main() {
    const config = JSON.parse(fs.readFileSync(process.env.ADMIN_TEST_CONFIG));
    if (!/^skymist_admin_test_[a-f0-9]{12}$/.test(config.database)) { throw new Error('Not an isolated test database'); }
    const sql = new Sequelize(config.database, config.user, config.password, { host: config.host, port: config.port || 3306, dialect: 'mysql', logging: false });
    try {
        const q = sql.getQueryInterface();
        await q.createTable('SequelizeMeta', { name: { type: Sequelize.STRING(255), primaryKey: true, allowNull: false } });
        const files = fs.readdirSync(require('node:path').join(__dirname, '../migrations')).filter(f => f.endsWith('.js')).sort();
        for (const file of files.filter(f => !f.startsWith('20261102') && !f.startsWith('20261108'))) {
            await require('../migrations/' + file).up(q, Sequelize);
            await q.bulkInsert('SequelizeMeta', [{ name: file }]);
        }
        await q.bulkInsert('accounts', ['dup@example.test', 'DUP@example.test'].map(email => ({
            email, hash: 'unused', battle_tag: 'Fixture', banned: 0, suspended: 0, created_at: new Date(), updated_at: new Date()
        })));
        await require('node:assert/strict').rejects(migration.up(q, Sequelize), error => error.code === 'BGS_EMAIL_CONFLICT');
        const rows = await q.select(null, 'accounts', { attributes: [[Sequelize.fn('COUNT', Sequelize.col('id')), 'n']] });
        require('node:assert/strict').equal(rows[0].n, 2);
        await q.bulkUpdate('accounts', { email: 'resolved@example.test' }, { id: 2 });
        await migration.up(q, Sequelize);
        await migration.up(q, Sequelize); // DDL interruption recovery is additive and idempotent.
        await q.bulkInsert('SequelizeMeta', [{ name: '20261102000000-administration.js' }]);
        await require('./guild-acceptance')(sql);
        const index = require('../migrations/20261108000000-admin-request-list-index');
        await index.up(q);
        await index.up(q);
        await q.bulkInsert('SequelizeMeta', [{ name: '20261108000000-admin-request-list-index.js' }]);
    }
    finally { await sql.close(); }
}
if (require.main === module) { main().catch(() => { console.error('Isolated administration schema acceptance failed'); process.exitCode = 1; }); }
