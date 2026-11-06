'use strict';
// Explicit, isolated MariaDB + Redis acceptance. Never reuse a production database.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const { Sequelize } = require('sequelize');
const { createClient } = require('redis');
const { watched } = require('../utils/redis-transaction');
const { CataclysmSessions, pendingKey, worldProof } = require('../realm/cataclysm-sessions');
const { ticketKey, leaseKey } = require('../realm/sessions');

async function main() {
    assert.equal(process.env.CATACLYSM_TEST, '1', 'Explicit test opt-in required');
    const port = name => { const n = Number(process.env[name]); assert(Number.isInteger(n) && n > 1024 && n <= 65535); return n; };
    const dbPort = port('CATACLYSM_TEST_DB_PORT'), redisPort = port('CATACLYSM_TEST_REDIS_PORT');
    const database = 'cataclysm_validation_' + crypto.randomBytes(6).toString('hex');
    const config = { host: '127.0.0.1', port: dbPort, dialect: 'mysql', username: 'root', password: 'local-validation-only', logging: false,
        dialectOptions: { supportBigNumbers: true, bigNumberStrings: true } };
    const root = new Sequelize({ ...config, database: 'mysql' });
    const redis = createClient({ url: 'redis://127.0.0.1:' + redisPort, disableOfflineQueue: true, socket: { reconnectStrategy: false } });
    redis.on('error', () => {});
    let sql;
    const ownedKeys = new Set();
    try {
        await root.query('CREATE DATABASE `' + database + '`');
        sql = new Sequelize({ ...config, database });
        const q = sql.getQueryInterface(), migration = require('../migrations/20261105000000-wow-license-identity');
        for (const file of fs.readdirSync(__dirname + '/../migrations').filter(f => f.endsWith('.js') && !f.startsWith('20261105')).sort()) {
            await require('../migrations/' + file).up(q, Sequelize);
        }
        await q.bulkInsert('accounts', [{ id: '9007199254740993', email: 'license@example.invalid', hash: 'unused', battle_tag: 'License#1', created_at: new Date(), updated_at: new Date() }]);
        await q.bulkInsert('game_accounts', ['9007199254741003', '9007199254741001', '9007199254741002'].map(id => ({ id, account_id: '9007199254740993', program: 'WoW', region: 1, expansion: 3, display_name: id, created_at: new Date(), updated_at: new Date() })));
        await migration.up(q); await migration.up(q);
        const [backfill] = await sql.query('SELECT CAST(id AS CHAR) AS id,wow_license_index AS idx FROM game_accounts ORDER BY id');
        assert.deepEqual(backfill.map(row => row.idx), [1, 2, 3]);
        const Account = require('../models/account')(sql, Sequelize.DataTypes), GameAccount = require('../models/gameaccount')(sql, Sequelize.DataTypes);
        const creates = await Promise.all(Array.from({ length: 4 }, (_, n) => sql.transaction(transaction => GameAccount.create({
            accountId: '9007199254740993', program: 'WoW', region: n + 1, expansion: n % 2 ? 6 : 3, displayName: 'Concurrent'
        }, { transaction }))));
        assert.deepEqual(creates.map(g => g.wowLicenseIndex).sort((a, b) => a - b), [4, 5, 6, 7]);
        const deleted = creates[0];
        await GameAccount.destroy({ where: { id: deleted.id } });
        const next = await sql.transaction(transaction => GameAccount.create({ accountId: '9007199254740993', program: 'WoW', region: 1, expansion: 3, displayName: 'No reuse' }, { transaction }));
        assert.equal(next.wowLicenseIndex, 8);
        await assert.rejects(sql.query('UPDATE game_accounts SET wow_license_index=99 WHERE id=:id', { replacements: { id: next.id } }), /immutable/);
        await assert.rejects(sql.query('UPDATE accounts SET wow_license_index_high_water=0'), /cannot decrease/);
        await assert.rejects(q.bulkInsert('game_accounts', [{ account_id: '9007199254740993', program: 'WoW', region: 1, expansion: 3, display_name: 'Invalid', created_at: new Date(), updated_at: new Date() }]), /Invalid WoW license allocation/);
        await assert.rejects(sql.transaction(async transaction => {
            await GameAccount.create({ accountId: '9007199254740993', program: 'WoW', region: 1, expansion: 3, displayName: 'Rollback' }, { transaction });
            throw new Error('rollback');
        }), /rollback/);
        assert.equal((await Account.findByPk('9007199254740993')).wowLicenseIndexHighWater, 8);
        await migration.up(q);

        await redis.connect();
        const store = { run: operation => operation(redis), transaction: async (keys, decide) => {
            keys.forEach(key => ownedKeys.add(key));
            const connection = redis.duplicate(); connection.on('error', () => {}); await connection.connect();
            try { return await watched(connection, keys, decide); } finally { await connection.close(); }
        } };
        const sessions = new CataclysmSessions(store), uid = crypto.randomUUID();
        const record = { version: 1, auth_protocol: 'wow-15595-v0', namespace: 'cataclysm-test', realm_uid: uid,
            game_account_id: '9007199254741001', account_id: '9007199254740993', wow_license_index: 1,
            realm_account_name: '9007199254740993#1', realm_key: crypto.randomBytes(40).toString('hex'), build: 15595, expansion: 3,
            region: 1, address: '::1', platform: 'Wn64', locale: 'enUS', gm_level: 0, issued_at_ms: Date.now() };
        record.expires_at_ms = record.issued_at_ms + 60000;
        const first = crypto.randomBytes(20).toString('hex'), second = crypto.randomBytes(20).toString('hex');
        await Promise.all([sessions.issue(first, record), sessions.issue(second, record)]);
        const pending = pendingKey(uid, record.realm_account_name), selected = await redis.get(pending);
        const old = selected === first ? second : first;
        assert.equal(await redis.exists(ticketKey(uid, old)), 0);
        assert.equal(await redis.pExpireTime(pending), await redis.pExpireTime(ticketKey(uid, selected)));
        const observed = await redis.get(ticketKey(uid, selected));
        const proposed = { version: 1, namespace: record.namespace, realm_uid: uid, pod_uid: crypto.randomUUID(), instance_id: crypto.randomUUID(),
            game_account_id: record.game_account_id, account_id: record.account_id, session_id: crypto.randomUUID(), generation: '0', build: 15595, expansion: 3, address: '127.0.0.1' };
        const proof = worldProof(record.realm_account_name, Buffer.from(record.realm_key, 'hex'), 7, 11);
        await assert.rejects(sessions.claim(selected, observed, proposed, Buffer.alloc(20), 7, 11), /INVALID_15595_PROOF/);
        assert.equal(await redis.get(pending), selected);
        const outcomes = await Promise.allSettled([sessions.claim(selected, observed, proposed, proof, 7, 11),
            sessions.claim(selected, observed, { ...proposed, session_id: crypto.randomUUID() }, proof, 7, 11)]);
        assert.equal(outcomes.filter(value => value.status === 'fulfilled').length, 1);
        const active = outcomes.find(value => value.status === 'fulfilled').value;
        const expiry = await redis.pExpireTime(leaseKey(active.game_account_id));
        assert.deepEqual(await sessions.claim(selected, observed, active, proof, 7, 11), active);
        assert.equal(await redis.pExpireTime(leaseKey(active.game_account_id)), expiry);
        assert.equal(await redis.exists(pending), 0);
        console.log('PASS MariaDB license migration/retry/concurrency/rollback/immutability and Redis v0 supersession/claim races/lost acknowledgement');
    } finally {
        if (redis.isReady) { if (ownedKeys.size) { await redis.del([...ownedKeys]); } await redis.close(); }
        if (sql) { await sql.close(); }
        await root.query('DROP DATABASE IF EXISTS `' + database + '`'); await root.close();
    }
}
if (require.main === module) { main().catch(error => { console.error(error); process.exitCode = 1; }); }
