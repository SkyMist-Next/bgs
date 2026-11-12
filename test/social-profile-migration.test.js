'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { Sequelize, DataTypes } = require('sequelize');
const { randomBytes } = require('node:crypto');
const migration = require('../migrations/20261112000001-social-profile');

test('BattleTag preflight reports exact account IDs and never writes on a collision', async () => {
    const queries = [];
    const q = { sequelize: { query: async sql => {
        queries.push(sql);
        return [[{ id: '9007199254740993' }, { id: '9007199254740994' }]];
    } } };
    await assert.rejects(migration.up(q, DataTypes), error => error.code === 'BGS_BATTLE_TAG_CONFLICT' &&
        error.message.includes('9007199254740993') && error.message.includes('9007199254740994'));
    assert.equal(queries.length, 1);
    assert.match(queries[0], /^SELECT/);
    await assert.rejects(migration.down(), /additive/);
});

test('migration refuses incompatible indexes including string-valued metadata', async () => {
    for (const index of [
        [{ non_unique: 1, column_name: 'battle_tag_case_key', prefix_length: null }],
        [{ non_unique: '1', column_name: 'battle_tag_case_key', prefix_length: null }],
        [{ non_unique: 0, column_name: 'battle_tag', prefix_length: null }],
        [{ non_unique: 0, column_name: 'battle_tag_case_key', prefix_length: 100 }]
    ]) {
        const q = {
            sequelize: { query: async sql => sql.includes('STATISTICS') ? [index] : [[]] },
            describeTable: async () => ({})
        };
        await assert.rejects(migration.up(q, DataTypes), /incompatible definition/);
    }
});

test('account profile model has nullable names and an explicit opt-out default', async () => {
    const db = new Sequelize('mysql://fixture@localhost/fixture', { logging: false });
    try {
        const Account = require('../models/account')(db, DataTypes);
        const account = Account.build({ id: '9007199254740993' });
        assert.equal(account.realIdEnabled, false);
        assert.equal(Account.rawAttributes.givenName.field, 'given_name');
        assert.equal(Account.rawAttributes.givenName.allowNull, true);
        assert.equal(Account.rawAttributes.surname.allowNull, true);
        assert.equal(Account.rawAttributes.realIdEnabled.field, 'real_id_enabled');
        assert.equal(Account.rawAttributes.realIdEnabled.allowNull, false);
    }
    finally { await db.close(); }
});

// Opt-in only: create and remove a uniquely named database on the isolated loopback test server.
// BGS_SOCIAL_TEST_PORT=33317 node --test --test-concurrency=1 test/social-profile-migration.test.js
test('MariaDB preserves accounts, rejects collisions and enforces full case-insensitive keys', {
    skip: !process.env.BGS_SOCIAL_TEST_PORT && process.env.SOCIAL_PROFILE_TEST_MYSQL !== '1', timeout: 30000
}, async () => {
    const port = Number(process.env.BGS_SOCIAL_TEST_PORT || 3306);
    assert.ok(Number.isInteger(port) && port > 0 && port <= 65535);
    const database = 'social_profile_test_' + randomBytes(6).toString('hex');
    const options = { host: '127.0.0.1', port, dialect: 'mysql', logging: false,
        dialectOptions: { supportBigNumbers: true, bigNumberStrings: true, charset: 'utf8mb4' } };
    const admin = new Sequelize('', 'root', '', options), db = new Sequelize(database, 'root', '', options);
    const q = db.getQueryInterface();
    let created = false;
    try {
        await admin.query(`CREATE DATABASE ${database} CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
        created = true;
        await db.query(`CREATE TABLE accounts (
            id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY, email VARCHAR(255) NOT NULL,
            hash VARCHAR(255) NOT NULL, battle_tag VARCHAR(255) NOT NULL,
            created_at DATETIME NOT NULL, updated_at DATETIME NOT NULL,
            UNIQUE KEY accounts_email_unique(email), KEY accounts_existing_tag_index(battle_tag)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
        const insert = (tag, email, id = null) => db.query(`INSERT INTO accounts
            (id,email,hash,battle_tag,created_at,updated_at) VALUES (?,?, 'preserved-hash',?,NOW(),NOW())`,
        { replacements: [id, email, tag] });
        await insert('Alice#1234', 'first@example.test', '9007199254740993');
        await insert('aLICE#1234', 'second@example.test', '9007199254740994');
        const indexes = await q.showIndex('accounts');
        await assert.rejects(migration.up(q, DataTypes), error => error.code === 'BGS_BATTLE_TAG_CONFLICT' &&
            error.message.includes('9007199254740993') && error.message.includes('9007199254740994'));
        assert.equal((await q.describeTable('accounts')).given_name, undefined);
        assert.deepEqual(await q.showIndex('accounts'), indexes);
        // Resolve only this test fixture; migration itself never renames accounts.
        await db.query("DELETE FROM accounts WHERE id='9007199254740994'");
        await migration.up(q, DataTypes);
        await migration.up(q, DataTypes); // Resumable after committed DDL.
        const [rows] = await db.query('SELECT CAST(id AS CHAR) AS id,battle_tag,hash,given_name,surname,real_id_enabled FROM accounts');
        assert.deepEqual(rows, [{ id: '9007199254740993', battle_tag: 'Alice#1234', hash: 'preserved-hash',
            given_name: null, surname: null, real_id_enabled: 0 }]);
        const after = await q.showIndex('accounts');
        for (const original of indexes) {
            const current = after.find(item => item.name === original.name);
            assert.equal(current.unique, original.unique);
            assert.deepEqual(current.fields, original.fields);
        }
        const duplicate = error => error.name === 'SequelizeUniqueConstraintError';
        await assert.rejects(insert('ALICE#1234', 'duplicate@example.test'), duplicate);
        await insert('Alice#12345', 'longer@example.test');
        await insert('Alice#1235', 'discriminator@example.test');
        await insert('Alice#1234 ', 'trailing-space@example.test');
        await insert('Élodie#1234', 'accent@example.test');
        await assert.rejects(insert('élodie#1234', 'accent-case@example.test'), duplicate);
        await insert('Elodie#1234', 'no-accent@example.test');
        await insert('😀'.repeat(250) + '#1234', 'maximum@example.test');
        await insert('😀'.repeat(250) + '#1235', 'maximum-different@example.test');
        const race = await Promise.allSettled([insert('Race#9876', 'race-one@example.test'), insert('rACE#9876', 'race-two@example.test')]);
        assert.equal(race.filter(item => item.status === 'fulfilled').length, 1);
        assert.equal(race.filter(item => item.status === 'rejected' && duplicate(item.reason)).length, 1);
        await assert.rejects(db.query("UPDATE accounts SET battle_tag='ALICE#1234' WHERE email='longer@example.test'"), duplicate);
        const [unchanged] = await db.query("SELECT battle_tag FROM accounts WHERE email='longer@example.test'");
        assert.equal(unchanged[0].battle_tag, 'Alice#12345');
        await q.removeIndex('accounts', 'accounts_battle_tag_case_unique');
        await q.addIndex('accounts', ['battle_tag_case_key'], { name: 'accounts_battle_tag_case_unique', unique: false });
        await assert.rejects(migration.up(q, DataTypes), /incompatible definition/);
        const [nonUnique] = await db.query("SELECT NON_UNIQUE AS value FROM information_schema.STATISTICS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='accounts' AND INDEX_NAME='accounts_battle_tag_case_unique'");
        assert.equal(Number(nonUnique[0].value), 1);
        await q.removeIndex('accounts', 'accounts_battle_tag_case_unique');
        await q.removeColumn('accounts', 'battle_tag_case_key');
        await q.addColumn('accounts', 'battle_tag_case_key', { type: DataTypes.STRING(255), allowNull: true });
        await assert.rejects(migration.up(q, DataTypes), /case key has an incompatible definition/);
    }
    finally {
        await db.close();
        try {
            if (created) {
                await admin.query(`DROP DATABASE ${database}`);
                const [rows] = await admin.query('SELECT SCHEMA_NAME FROM information_schema.SCHEMATA WHERE SCHEMA_NAME = ?', { replacements: [database] });
                assert.equal(rows.length, 0);
            }
        }
        finally { await admin.close(); }
    }
});
