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
        await sql.query('CREATE TABLE SequelizeMeta(name VARCHAR(255) PRIMARY KEY)');
        const files = fs.readdirSync(require('node:path').join(__dirname, '../migrations')).filter(f => f.endsWith('.js')).sort();
        for (const file of files.filter(f => !f.startsWith('20261102'))) {
            await require('../migrations/' + file).up(q, Sequelize);
            await sql.query('INSERT INTO SequelizeMeta VALUES (?)', { replacements: [file] });
        }
        await sql.query("INSERT INTO accounts(email,hash,battle_tag,banned,suspended,created_at,updated_at) VALUES ('dup@example.test','unused','Fixture',0,0,NOW(),NOW()),('DUP@example.test','unused','Fixture',0,0,NOW(),NOW())");
        await require('node:assert/strict').rejects(migration.up(q, Sequelize), error => error.code === 'BGS_EMAIL_CONFLICT');
        const [rows] = await sql.query('SELECT COUNT(*) AS n FROM accounts');
        require('node:assert/strict').equal(rows[0].n, 2);
        await sql.query("UPDATE accounts SET email='resolved@example.test' WHERE id=2");
        await migration.up(q, Sequelize);
        await migration.up(q, Sequelize); // DDL interruption recovery is additive and idempotent.
        await sql.query('INSERT INTO SequelizeMeta VALUES (?)', { replacements: ['20261102000000-administration.js'] });
    }
    finally { await sql.close(); }
}
if (require.main === module) { main().catch(() => { console.error('Isolated administration schema acceptance failed'); process.exitCode = 1; }); }
