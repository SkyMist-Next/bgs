'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { Sequelize, DataTypes } = require('sequelize');
const { randomBytes, randomUUID } = require('node:crypto');
const defineModels = require('../models/socialgraph');
const migration = require('../migrations/20261112000002-social-graph');
const { SocialGraph } = require('../social/graph');
const SocialRuntime = require('../social/runtime');
const parse = value => typeof value === 'string' ? JSON.parse(value) : value;

// Opt in against a disposable loopback MariaDB root with no password, never a shared installation.
// BGS_SOCIAL_TEST_PORT=33317 node --test test/social-graph-sql.test.js
test('social graph InnoDB migration, policy, concurrency and transactional recovery', {
    skip: !process.env.BGS_SOCIAL_TEST_PORT, timeout: 60000
}, async t => {
    const port = Number(process.env.BGS_SOCIAL_TEST_PORT);
    assert.ok(Number.isInteger(port) && port > 0 && port <= 65535);
    const database = `social_graph_test_${randomBytes(6).toString('hex')}`;
    const options = { dialect: 'mysql', host: '127.0.0.1', port, logging: false,
        dialectOptions: { supportBigNumbers: true, bigNumberStrings: true, jsonStrings: true }, pool: { max: 8 } };
    const admin = new Sequelize('', 'root', '', options);
    const sequelize = new Sequelize(database, 'root', '', options);
    let created = false;
    t.after(async () => {
        await sequelize.close();
        try {
            if (created) {
                await admin.query(`DROP DATABASE ${database}`);
                const [rows] = await admin.query('SELECT SCHEMA_NAME FROM information_schema.SCHEMATA WHERE SCHEMA_NAME = ?', { replacements: [database] });
                assert.equal(rows.length, 0);
                t.diagnostic('Removed disposable schema ' + database);
            }
        } finally { await admin.close(); }
    });
    await admin.query(`CREATE DATABASE ${database} CHARACTER SET utf8mb4 COLLATE utf8mb4_bin`);
    created = true;
    await sequelize.query(`CREATE TABLE accounts (id BIGINT PRIMARY KEY, battle_tag VARCHAR(255) NOT NULL,
        given_name VARCHAR(255), surname VARCHAR(255), real_id_enabled TINYINT(1) NOT NULL DEFAULT 0) ENGINE=InnoDB`);
    const Account = sequelize.define('Account', {
        id: { type: DataTypes.BIGINT, primaryKey: true }, battleTag: DataTypes.STRING,
        givenName: DataTypes.STRING, surname: DataTypes.STRING, realIdEnabled: DataTypes.BOOLEAN
    }, { tableName: 'accounts', underscored: true, timestamps: false });
    const models = { ...defineModels(sequelize, DataTypes), ...require('../models/socialruntime')(sequelize, DataTypes) };
    await migration.up(sequelize.getQueryInterface());
    await migration.up(sequelize.getQueryInterface());
    await require('../migrations/20261112000003-social-runtime').up(sequelize.getQueryInterface(), DataTypes);
    await require('../migrations/20261112000006-session-social-blocks').up(sequelize.getQueryInterface());
    const routeMigration = require('../migrations/20261112000007-social-world-routes');
    await routeMigration.up(sequelize.getQueryInterface());
    await routeMigration.up(sequelize.getQueryInterface());
    const graph = new SocialGraph({ sequelize, Account, models });
    let nextId = 9007199254740993n;
    async function account() {
        const id = String(nextId++);
        await Account.create({ id, battleTag: `Player#${id}`, givenName: 'Private', surname: 'Name', realIdEnabled: true });
        return id;
    }
    async function invite(actorId, targetId, kind = 'battle_tag', operationId = 'invite') {
        return graph.invite({ actorId, targetId, kind, operationId });
    }
    async function accounts(count) {
        const ids = Array.from({ length: count }, () => String(nextId++));
        await Account.bulkCreate(ids.map(id => ({ id, battleTag: `Player#${id}`, realIdEnabled: false })));
        return ids;
    }
    const runtime = () => new SocialRuntime({ models: { sequelize, Account, ...models } });

    await t.test('native SQL JSON and BIGINT preserve identities and revisions beyond Number precision', async () => {
        const a = await account(); const b = await account();
        await sequelize.query('ALTER TABLE social_invitations AUTO_INCREMENT = 9007199254740993');
        await models.SocialRevision.create({ accountId: a, revision: '9007199254740999' });
        const pending = await invite(a, b);
        assert.equal(pending.invitationId, '9007199254740993');
        assert.equal(pending.revisions[a], '9007199254741000');
        assert.deepEqual(await invite(a, b), pending);
        const accepted = await graph.accept({ actorId: b, targetId: a, invitationId: pending.invitationId, operationId: 'accept' });
        assert.equal(accepted.revisions[a], '9007199254741001');
        const snapshot = await graph.snapshot(a);
        assert.equal(snapshot.friends[0].accountId, b);
        assert.equal(snapshot.friends[0].fullName, '');
        assert.equal(snapshot.revision, '9007199254741001');
        const events = await graph.pendingOutbox();
        assert.ok(events.every(event => typeof event.payload.accountId === 'string' && typeof event.revision === 'string'));
        await graph.acknowledgeOutbox(events);
        assert.equal((await graph.pendingOutbox()).length, 0);
    });

    await t.test('failed outbox insert rolls back friendship, invitation removal, revision and receipt', async () => {
        const a = await account(); const b = await account();
        const pending = await invite(a, b);
        const create = models.SocialOutbox.create;
        models.SocialOutbox.create = async () => { throw new Error('Injected SQL outbox failure'); };
        const input = { actorId: b, targetId: a, invitationId: pending.invitationId, operationId: 'accept' };
        try { await assert.rejects(graph.accept(input), /Injected SQL outbox failure/); }
        finally { models.SocialOutbox.create = create; }
        const snapshot = await graph.snapshot(a);
        assert.equal(snapshot.friends.length, 0);
        assert.equal(snapshot.sentInvitations.length, 1);
        assert.equal(snapshot.revision, '1');
        assert.equal(await models.SocialMutation.count({ where: { accountId: b } }), 0);
        assert.equal((await graph.accept(input)).changed, true);
    });

    await t.test('opposite-direction accept/block races cannot bypass the block or deadlock', async () => {
        for (let i = 0; i < 6; i++) {
            const a = await account(); const b = await account();
            const pending = await invite(a, b);
            const operations = [
                () => graph.block({ actorId: a, targetId: b, operationId: 'block' }),
                () => graph.accept({ actorId: b, targetId: a, invitationId: pending.invitationId, operationId: 'accept' })
            ];
            if (i % 2) { operations.reverse(); }
            const results = await Promise.allSettled(operations.map(operation => operation()));
            assert.ok(results.every(result => result.status === 'fulfilled' || result.reason.code === 'BLOCKED'));
            assert.equal((await graph.access(a, b)).blocked, true);
            assert.equal((await graph.snapshot(a)).friends.length, 0);
            assert.equal((await graph.snapshot(b)).receivedInvitations.length, 0);
        }
    });

    await t.test('two accepts compete for one remaining parent-account friend slot', async () => {
        const a = await account(); const b = await account(); const c = await account();
        const first = await invite(b, a); const second = await invite(c, a);
        const limited = new SocialGraph({ sequelize, Account, models, limits: { friends: 1 } });
        const results = await Promise.allSettled([[b, first], [c, second]].map(([targetId, pending]) => limited.accept({
            actorId: a, targetId, invitationId: pending.invitationId, operationId: `accept:${targetId}`
        })));
        assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
        assert.equal(results.find(result => result.status === 'rejected').reason.code, 'FRIEND_LIMIT');
        assert.equal((await limited.snapshot(a)).friends.length, 1);
        assert.equal((await limited.snapshot(a)).receivedInvitations.length, 1);
    });

    await t.test('actual profile opt-out redacts accepted Real ID snapshots and projections', async () => {
        const a = await account(); const b = await account();
        const pending = await invite(a, b, 'real_id');
        await graph.accept({ actorId: b, targetId: a, invitationId: pending.invitationId, operationId: 'accept' });
        assert.equal((await graph.project(a, b)).fullName, 'Private Name');
        await Account.update({ realIdEnabled: false }, { where: { id: b } });
        assert.equal((await graph.project(a, b)).fullName, '');
        assert.equal((await graph.snapshot(b)).friends[0].fullName, '');
    });

    await t.test('real parent locks enforce the 100-target durable/session union across licenses and duplicate rows', async () => {
        for (const sessionFirst of [false, true]) {
            const [actorId, ...targets] = await accounts(102);
            const service = runtime();
            // Authentication/Redis is controlled here; both mutation paths, models and InnoDB locks are real.
            service.current = async (route, accountId) => ({ accountId, sessionKey: 'c:' + route.connectionId });
            const session = { accountId: actorId, sessionKey: 'c:' + randomUUID() };
            session.route = { type: 'connection', connectionId: session.sessionKey.slice(2) };
            const otherSession = { ...session, sessionKey: 'c:' + randomUUID() };
            otherSession.route = { type: 'connection', connectionId: otherSession.sessionKey.slice(2) };
            const at = new Date();
            await models.SocialBlock.bulkCreate(targets.slice(0, 49).map(blockedId => ({ accountId: actorId, blockedId, createdAt: at })));
            await models.SocialSessionBlock.bulkCreate([session, otherSession].flatMap(owner => targets.slice(49, 99).map(blockedAccountId => ({
                id: randomUUID(), accountId: actorId, blockedAccountId, sessionKey: owner.sessionKey, route: owner.route, createdAt: at
            }))));
            const durable = () => graph.block({ actorId, targetId: targets[99], operationId: 'last-durable-slot' });
            const temporary = () => service.blockSession(session, targets[100]);
            const results = await Promise.allSettled((sessionFirst ? [temporary, durable] : [durable, temporary]).map(run => run()));
            assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
            const failure = results.find(result => result.status === 'rejected').reason;
            assert.ok(failure === 0x1F45 || failure.code === 'BLOCK_LIMIT');
            const [union] = await sequelize.query(`SELECT blocked_id AS target FROM social_blocks WHERE account_id = ?
                UNION SELECT blocked_account_id AS target FROM social_session_blocks WHERE account_id = ?`, { replacements: [actorId, actorId] });
            assert.equal(union.length, 100);
            assert.ok(union.every(row => typeof row.target === 'string'));
            const remaining = [targets[99], targets[100]].find(target => !union.some(row => row.target === target));
            await assert.rejects(graph.block({ actorId, targetId: remaining, operationId: 'too-many' }), error => error.code === 'BLOCK_LIMIT');
            await assert.rejects(service.blockSession(otherSession, remaining), error => error === 0x1F45);
            // Cross-list and cross-license duplicates must remain legal at the native capacity.
            assert.equal((await graph.block({ actorId, targetId: targets[70], operationId: 'already-counted' })).changed, true);
            assert.equal(await service.blockSession(otherSession, targets[0]), true);
            assert.equal(await service.blockSession(otherSession, targets[0]), false);
            assert.equal((await service.sessionBlocks(otherSession)).length, 51);
            assert.equal(await models.SocialMutation.count({ where: { accountId: actorId, operationId: 'too-many' } }), 0);
        }
    });

    await t.test('migration 07 retains a zero-subscription uint64 epoch fence and rejects stale SQL writers', async () => {
        const accountId = await account(), gameAccountId = String(nextId++);
        const owner = { account_id: accountId, game_account_id: gameAccountId, session_id: randomUUID(), generation: '9007199254741993',
            namespace: 'test', realm_uid: randomUUID(), pod_uid: randomUUID(), instance_id: randomUUID(), build: 26972, routeEpoch: '9007199254740993' };
        const service = runtime(), replica = runtime();
        // Only the external lease validator is controlled; route rows and transactional fences use SQL.
        service.current = replica.current = async () => ({ accountId, gameAccountId });
        const key = { sessionKey: 'w:' + owner.session_id + ':' + owner.generation };
        assert.equal((await service.refreshWorldRoute(owner, 'queue-one')).changed, true);
        assert.equal(await models.SocialSubscription.count({ where: key }), 0);
        await routeMigration.up(sequelize.getQueryInterface());
        assert.equal((await replica.refreshWorldRoute(owner, 'queue-one')).changed, false);
        await assert.rejects(replica.refreshWorldRoute(owner, 'queue-conflict'), error => error === 0xA);
        await assert.rejects(replica.refreshWorldRoute({ ...owner, routeEpoch: '9007199254740992' }, 'queue-old'), error => error === 0xA);
        for (const kind of ['friends', 'blocks', 'presence']) {
            const context = {};
            service.register(kind, {});
            service.worldContext(context, owner, 'queue-one');
            await service.subscribe(context, await service.session(context), kind, accountId, '18446744073709551615', {}, { value: 'baseline' });
            await context.afterReply();
        }
        const next = { ...owner, routeEpoch: '9007199254740994' };
        await replica.refreshWorldRoute(next, 'queue-two');
        const rows = await models.SocialSubscription.findAll({ where: key, raw: true });
        assert.equal(rows.length, 3);
        for (const row of rows) {
            assert.equal(parse(row.route).queueName, 'queue-two'); assert.equal(Number(row.ready), 1);
            assert.equal(row.objectId, '18446744073709551615');
            assert.deepEqual(parse(row.snapshot), row.kind === 'presence' ? null : { value: 'baseline' });
        }
        const stale = {};
        service.worldContext(stale, owner, 'queue-one');
        await assert.rejects(service.subscribe(stale, await service.session(stale), 'friends', accountId, '2'), error => error === 0xA);
        const results = await Promise.allSettled([
            service.refreshWorldRoute({ ...owner, routeEpoch: '18446744073709551615' }, 'queue-max'),
            replica.refreshWorldRoute({ ...owner, routeEpoch: '18446744073709551614' }, 'queue-previous')
        ]);
        assert.equal(results[0].status, 'fulfilled');
        assert.ok(results[1].status === 'fulfilled' || results[1].reason === 0xA);
        const stored = await models.SocialWorldRoute.findOne({ where: key, raw: true });
        assert.equal(stored.routeEpoch, '18446744073709551615');
        assert.equal(parse(stored.route).queueName, 'queue-max');
        await assert.rejects(models.SocialWorldRoute.create({ ...stored, id: randomUUID() }), error => error.name === 'SequelizeUniqueConstraintError');
        await assert.rejects(models.SocialWorldRoute.update({ routeEpoch: '0' }, { where: key }));
        await assert.rejects(models.SocialWorldRoute.update({ routeEpoch: '18446744073709551616' }, { where: key }));
        assert.equal((await models.SocialWorldRoute.findOne({ where: key, raw: true })).routeEpoch, '18446744073709551615');
        const [indexes] = await sequelize.query(`SELECT COLUMN_NAME AS column_name FROM information_schema.STATISTICS
            WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='social_session_blocks'
            AND INDEX_NAME='social_session_block_parent_target' ORDER BY SEQ_IN_INDEX`);
        assert.deepEqual(indexes.map(row => row.column_name), ['account_id', 'blocked_account_id']);
    });

    await t.test('schema rejects invalid semantic kinds, reversed pairs and missing parent accounts', async () => {
        const a = await account(); const b = await account();
        await assert.rejects(sequelize.query('INSERT INTO social_friendships VALUES (?, ?, ?, NOW())', {
            replacements: [a, b, '1']
        }));
        await assert.rejects(sequelize.query('INSERT INTO social_friendships VALUES (?, ?, ?, NOW())', {
            replacements: [b, a, 'battle_tag']
        }));
        await assert.rejects(sequelize.query('INSERT INTO social_revisions VALUES (?, 0)', { replacements: ['1'] }));
    });
});
