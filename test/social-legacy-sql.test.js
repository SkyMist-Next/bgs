'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { randomBytes, randomUUID } = require('node:crypto');
const { Sequelize, DataTypes, Op } = require('sequelize');
const Long = require('long');
const SocialRuntime = require('../social/runtime');
const WorldPresence = require('../social/world-presence');
const { LegacyChat, STATUS, LIMITS, CLOSURE_SNAPSHOT_CAPACITY, entity, FILE, NAMESPACE } = require('../social/legacy-chat');
const loadProto = require('../utils/protobuf');

const code = name => error => error.status === STATUS[name];
const json = value => typeof value === 'string' ? JSON.parse(value) : value;
const OBJECT = '18446744073709551615';
const migrations = ['20261112000002-social-graph', '20261112000003-social-runtime',
    '20261112000004-legacy-chat', '20261112000005-social-presence', '20261112000006-session-social-blocks',
    '20261112000007-social-world-routes'];

// Only Redis/session ownership and publisher confirmations are controlled here.
// Group authority, graph policy, transactions, subscriptions and fencing are real SQL.
function memoryStore() {
    const rows = new Map(); let tail = Promise.resolve();
    const store = { rows, now: Date.now(), unavailable: false };
    const get = key => {
        const row = rows.get(key);
        if (row?.expiresAt <= store.now) { rows.delete(key); return null; }
        return row?.value ?? null;
    };
    const client = {
        get: async key => get(key),
        mGet: async keys => keys.map(get),
        pTTL: async key => get(key) === null ? -2 : rows.get(key).expiresAt - store.now,
        set: async (key, value, options = {}) => {
            const present = get(key) !== null;
            if (options.NX && present || options.XX && !present) { return null; }
            rows.set(key, { value, expiresAt: options.KEEPTTL ? rows.get(key).expiresAt : store.now + options.EX * 1000 });
            return 'OK';
        }
    };
    store.run = async work => { if (store.unavailable) { throw new Error('Redis temporarily unavailable'); } return work(client); };
    store.getConnectionIdentity = async connectionId => {
        const raw = await store.run(c => c.get('/aurora/connections/' + connectionId));
        return raw ? JSON.parse(raw) : null;
    };
    store.transaction = async (keys, decide) => {
        assert.ok(keys.length > 0);
        let release; const before = tail;
        tail = new Promise(resolve => { release = resolve; });
        await before;
        try {
            return await store.run(async client => {
                const decision = await decide(client);
                for (const [command, key, value, ...args] of decision.commands) {
                    assert.equal(command, 'SET');
                    const options = {};
                    for (let index = 0; index < args.length; index++) {
                        const arg = args[index]; options[arg] = arg === 'EX' ? Number(args[++index]) : true;
                    }
                    await client.set(key, value, options);
                }
                return decision.result;
            });
        } finally { release(); }
    };
    return store;
}

function modelsFor(sequelize) {
    const options = tableName => ({ tableName, timestamps: false, underscored: true, engine: 'InnoDB' });
    return {
        sequelize,
        Account: sequelize.define('Account', {
            id: { type: DataTypes.BIGINT, primaryKey: true }, battleTag: { type: DataTypes.STRING, allowNull: false },
            givenName: DataTypes.STRING, surname: DataTypes.STRING, realIdEnabled: { type: DataTypes.BOOLEAN, defaultValue: true }
        }, options('accounts')),
        GameAccount: sequelize.define('GameAccount', {
            id: { type: DataTypes.BIGINT, primaryKey: true }, accountId: { type: DataTypes.BIGINT, allowNull: false },
            program: DataTypes.STRING(4), region: DataTypes.INTEGER, expansion: DataTypes.INTEGER,
            isBanned: { type: DataTypes.BOOLEAN, defaultValue: false }, isSuspended: { type: DataTypes.BOOLEAN, defaultValue: false }
        }, options('game_accounts')),
        RealmProcessOwner: sequelize.define('RealmProcessOwner', {
            realm_uid: { type: DataTypes.STRING(36), primaryKey: true }, instance_id: DataTypes.STRING(36)
        }, options('realm_process_owners')),
        ...require('../models/socialgraph')(sequelize, DataTypes),
        ...require('../models/socialruntime')(sequelize, DataTypes),
        ...require('../models/sociallegacy')(sequelize, DataTypes),
        ...require('../models/socialpresence')(sequelize, DataTypes)
    };
}

// Explicit opt-in: an existing disposable loopback MariaDB, never a shared schema.
// BGS_SOCIAL_TEST_PORT=33317 node --test --test-concurrency=1 test/social-legacy-sql.test.js
test('legacy groups and social runtime/presence migrations against real InnoDB', {
    skip: !process.env.BGS_SOCIAL_TEST_PORT, timeout: 60000
}, async t => {
    const port = Number(process.env.BGS_SOCIAL_TEST_PORT);
    assert.ok(Number.isInteger(port) && port > 0 && port <= 65535);
    const database = 'social_legacy_test_' + randomBytes(6).toString('hex');
    const options = { dialect: 'mysql', host: '127.0.0.1', port, logging: false,
        dialectOptions: { supportBigNumbers: true, bigNumberStrings: true, jsonStrings: true },
        pool: { max: 4, acquire: 10000 }, retry: { max: 0 } };
    const admin = new Sequelize('', 'root', '', { ...options, pool: { max: 1 } });
    const connections = [new Sequelize(database, 'root', '', options), new Sequelize(database, 'root', '', options)];
    t.after(async () => {
        try {
            for (const sequelize of connections) { await sequelize.close(); }
            await admin.query(`DROP DATABASE IF EXISTS ${database}`);
        } finally { await admin.close(); }
    });
    await admin.query(`CREATE DATABASE ${database} CHARACTER SET utf8mb4 COLLATE utf8mb4_bin`);
    const models = connections.map(modelsFor), M = models[0], sequelize = connections[0];
    for (const name of ['Account', 'GameAccount', 'RealmProcessOwner']) { await M[name].sync(); }
    for (const name of migrations) { await require('../migrations/' + name).up(sequelize.getQueryInterface(), DataTypes); }
    const store = memoryStore(), deliveries = [];
    const replicas = models.map(models => {
        const runtime = new SocialRuntime({ models, store, logger: { warn() {} } });
        const worldPresence = new WorldPresence(store, models);
        const chat = new LegacyChat(runtime, { worldPresence });
        runtime.notify = async (row, frames) => {
            if (!await runtime.current(json(row.route), String(row.accountId))) { return false; }
            deliveries.push({ row, frames });
            if (runtime.uncertain) { throw new Error('Publisher confirmation lost'); }
            return true;
        };
        return { models, runtime, chat, worldPresence };
    });
    let nextParent = 9007199254740993n, nextGame = 9007199254741993n, token = 0;
    async function actor(parentId, existingGameId) {
        parentId ||= String(nextParent++);
        if (!await M.Account.findByPk(parentId)) {
            await M.Account.create({ id: parentId, battleTag: 'Public#' + parentId, givenName: 'Private', surname: 'Person', realIdEnabled: true });
        }
        const gameId = existingGameId || String(nextGame++);
        let game = await M.GameAccount.findByPk(gameId, { raw: true });
        if (!game) {
            game = { id: gameId, accountId: parentId, program: 'WoW', region: 3, expansion: 3 };
            await M.GameAccount.create(game);
        }
        const connectionId = randomUUID(), address = '127.0.0.1';
        await store.run(client => client.set('/aurora/connections/' + connectionId,
            JSON.stringify({ accountId: parentId, applicationVersion: 15595, address }), { EX: 300 }));
        return { accountId: parentId, gameId, game, connectionId, address, generation: '1' };
    }
    function context(actor, request = {}, operationToken = ++token) {
        return { identity: { connectionId: actor.connectionId, address: actor.address }, queueName: 'q:' + actor.connectionId,
            header: { token: operationToken, serviceHash: 1, methodId: 1 }, request: {
                version: 1, gameAccountId: entity(actor.game), generation: actor.generation, ...request
            } };
    }
    async function subscribe(actor, replica = replicas[0], objectId = OBJECT) {
        const call = context(actor, { objectId });
        const result = await replica.chat.subscribe(call); await call.afterReply?.();
        actor.generation = result.generation; actor.owner = await replica.runtime.owner(context(actor));
        return result;
    }
    async function friends(a, b, kind = 'battle_tag') {
        const graph = replicas[0].runtime.graph;
        const { invitationId } = await graph.invite({ actorId: a.accountId, targetId: b.accountId, kind, operationId: 'invite:' + ++token });
        await graph.accept({ actorId: b.accountId, targetId: a.accountId, invitationId, operationId: 'accept:' + ++token });
    }
    async function trio() {
        const actors = [await actor(), await actor(), await actor()];
        for (const member of actors) { await subscribe(member); }
        await friends(actors[0], actors[1]); await friends(actors[0], actors[2]);
        return actors;
    }
    const createContext = (a, b, c, operationToken) => context(a, { first: entity(b.game), second: entity(c.game) }, operationToken);
    const snapshot = (member, replica = replicas[0]) => replica.chat.snapshot(member.owner, member.gameId, member.generation);
    const members = groupId => M.SocialLegacyMember.findAll({ where: { groupId }, raw: true });

    await t.test('migrations match model columns/indexes and preserve JSON plus signed/unsigned 64-bit IDs', async () => {
        const q = sequelize.getQueryInterface();
        for (const [name, model] of Object.entries(M)) {
            if (!/^SocialLegacy|^SocialSubscription$|^SocialPresenceState$/.test(name)) { continue; }
            const columns = await q.describeTable(model.getTableName());
            assert.deepEqual(Object.keys(columns).sort(), Object.values(model.rawAttributes).map(field => field.field).sort(), name);
        }
        const [tables] = await sequelize.query('SELECT TABLE_NAME, ENGINE FROM information_schema.TABLES WHERE TABLE_SCHEMA = ?', { replacements: [database] });
        assert.ok(tables.every(table => table.ENGINE === 'InnoDB'));
        const indexes = await q.showIndex('social_subscriptions');
        assert.ok(indexes.some(index => index.unique && index.fields.map(field => field.attribute).join(',') === 'session_key,kind,target,object_id'));
        const a = await actor(); await subscribe(a);
        const row = await M.SocialSubscription.findOne({ where: { accountId: a.accountId }, raw: true });
        assert.equal(String(row.accountId), a.accountId); assert.equal(String(row.gameAccountId), a.gameId);
        assert.equal(String(row.objectId), OBJECT); assert.equal(row.ready, 1);
        assert.equal(Long.fromValue(json(row.snapshot).gameAccountId.low).toString(), a.gameId);
        const connection = store.rows.get('/aurora/connections/' + a.connectionId);
        assert.equal(JSON.parse(connection.value).gameAccountId, a.gameId);
        assert.equal(connection.expiresAt, store.now + 300000, 'selection preserves principal TTL');
        await assert.rejects(M.SocialSubscription.create({ ...row, id: randomUUID() }), error => error.name === 'SequelizeUniqueConstraintError');
        const values = { publicName: 'Public#1234', entity: { high: OBJECT, low: a.gameId } };
        await M.SocialPresenceState.create({ subject: 'g:' + a.gameId, accountId: a.accountId, values });
        const persisted = await models[1].SocialPresenceState.findByPk('g:' + a.gameId, { raw: true });
        assert.equal(String(persisted.accountId), a.accountId); assert.deepEqual(json(persisted.values), values);
    });

    await t.test('replica mutation receipts serialize Create/Invite/Leave duplicates and rollback failed receipts', async () => {
        const [a, b, c] = await trio(), operation = ++token;
        const results = await Promise.all(replicas.map(replica => replica.chat.create(createContext(a, b, c, operation))));
        assert.equal(results[0].affectedGroupId, results[1].affectedGroupId);
        assert.equal((await members(results[0].affectedGroupId)).length, 3);
        assert.equal(await M.SocialLegacyMutation.count({ where: { accountId: a.accountId } }), 1);
        await assert.rejects(replicas[1].chat.create(createContext(a, c, b, operation)), code('LEGACY_OPERATION_CONFLICT'));
        const count = await M.SocialLegacyGroup.count();
        const original = M.SocialLegacyMutation.create;
        M.SocialLegacyMutation.create = async () => { throw new Error('Receipt write failed'); };
        const failed = createContext(a, b, c);
        try { await assert.rejects(replicas[0].chat.create(failed), /Receipt write failed/); }
        finally { M.SocialLegacyMutation.create = original; }
        assert.equal(await M.SocialLegacyGroup.count(), count);
        assert.equal(await M.SocialLegacyMember.count({ where: { gameAccountId: a.gameId } }), 1);
        await replicas[0].chat.create(failed);
        assert.equal(await M.SocialLegacyMember.count({ where: { gameAccountId: a.gameId } }), 2);
        const d = await actor(); await subscribe(d); await friends(a, d);
        const groupId = results[0].affectedGroupId;
        const invite = context(a, { groupId, target: entity(d.game) });
        await Promise.all(replicas.map(replica => replica.chat.invite(invite)));
        assert.equal((await members(groupId)).length, 4);
        const leave = context(d, { groupId });
        await Promise.all(replicas.map(replica => replica.chat.leave(leave)));
        assert.equal((await members(groupId)).length, 3);
    });

    await t.test('two replicas compete for the sixth group slot without over-admission', async () => {
        const [a, b, c] = await trio();
        for (let index = 0; index < 5; index++) { await replicas[0].chat.create(createContext(a, b, c)); }
        const results = await Promise.allSettled(replicas.map(replica => replica.chat.create(createContext(a, b, c))));
        assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
        assert.ok(code('LEGACY_CAPACITY')(results.find(result => result.status === 'rejected').reason));
        for (const member of [a, b, c]) {
            assert.equal(await M.SocialLegacyMember.count({ where: { gameAccountId: member.gameId } }), LIMITS.groups);
        }
    });

    await t.test('64 pending closures stop admission, 70 fit recovery, and confirmed reconciliation releases capacity', async () => {
        assert.equal(LIMITS.pendingClosures, 64);
        assert.equal(CLOSURE_SNAPSHOT_CAPACITY, 70);
        const [a, b, c] = await trio(), active = [];
        for (let index = 0; index < LIMITS.groups; index++) {
            active.push((await replicas[0].chat.create(createContext(a, b, c))).affectedGroupId);
        }
        const d = await actor(); await subscribe(d); await friends(a, d);
        const closure = member => ({ groupId: randomUUID(), gameAccountId: member.gameId, accountId: member.accountId,
            sessionKey: member.owner.sessionKey, generation: member.generation, peerGameAccountId: b.gameId,
            peerAccountId: b.accountId, createdAt: new Date() });
        for (const member of [a, d]) {
            await M.SocialLegacyClosed.bulkCreate(Array.from({ length: LIMITS.pendingClosures }, () => closure(member)));
        }
        await assert.rejects(replicas[1].chat.invite(context(a, { groupId: active[0], target: entity(d.game) })), code('LEGACY_CAPACITY'));
        assert.equal(await M.SocialLegacyMember.count({ where: { gameAccountId: d.gameId } }), 0);
        await replicas[0].chat.cleanup(100);
        assert.equal(await M.SocialLegacyClosed.count({ where: { gameAccountId: a.gameId } }), 64);
        for (let index = 0; index < active.length; index++) {
            await replicas[index % 2].chat.leave(context(c, { groupId: active[index] }));
        }
        const full = await snapshot(a, replicas[1]);
        assert.equal(full.closed.length, 70, 'all already admitted groups can close without evicting pending metadata');
        assert.equal(full.groups.length, 0);
        await assert.rejects(replicas[0].chat.create(createContext(a, b, c)), code('LEGACY_CAPACITY'));
        assert.equal(await M.SocialLegacyMember.count({ where: { gameAccountId: a.gameId } }), 0);
        const overflow = closure(a);
        await M.SocialLegacyClosed.create(overflow);
        await assert.rejects(snapshot(a, replicas[1]), code('LEGACY_CAPACITY'));
        assert.equal(await M.SocialLegacyClosed.count({ where: { gameAccountId: a.gameId } }), 71, 'invalid overflow is rejected, never trimmed');
        await M.SocialLegacyClosed.destroy({ where: { groupId: overflow.groupId, gameAccountId: a.gameId } });
        const subscription = await M.SocialSubscription.findOne({ where: { accountId: a.accountId, kind: 'legacy' }, raw: true });
        const runtime = replicas[1].runtime;
        runtime.uncertain = true;
        try { await assert.rejects(runtime.reconcileRow(subscription.id), /Publisher confirmation lost/); }
        finally { runtime.uncertain = false; }
        assert.equal(json((await M.SocialSubscription.findByPk(subscription.id, { raw: true })).snapshot).closed.length, 0);
        await replicas[0].chat.cleanup(100);
        assert.equal(await M.SocialLegacyClosed.count({ where: { gameAccountId: a.gameId } }), 70, 'uncertain delivery keeps all capacity reserved');
        await runtime.reconcileRow(subscription.id);
        const delivered = deliveries.at(-1).frames;
        assert.equal(delivered.length, 71);
        assert.ok(delivered.slice(0, -1).every(frame => frame.methodId === 3));
        assert.equal(delivered.at(-1).methodId, 1);
        assert.ok(delivered.every(frame => frame.payload.length <= 262144));
        assert.equal(json((await M.SocialSubscription.findByPk(subscription.id, { raw: true })).snapshot).closed.length, 70);
        await replicas[0].chat.cleanup(100);
        assert.equal(await M.SocialLegacyClosed.count({ where: { gameAccountId: a.gameId } }), 0);
        assert.equal(await M.SocialLegacyClosed.count({ where: { gameAccountId: d.gameId } }), 64, 'unacknowledged target session is unaffected');
        assert.equal((await replicas[1].chat.create(createContext(a, b, c))).groups.length, 1, 'confirmed reconciliation unblocks subsequent admission');
    });

    await t.test('distinct licenses count separately while two concurrent invites compete for member twelve', async () => {
        const groupActors = await trio();
        for (let index = 3; index < 13; index++) {
            const member = await actor(index === 3 ? groupActors[1].accountId : undefined);
            await subscribe(member);
            if (index !== 3) { await friends(groupActors[0], member); }
            groupActors.push(member);
        }
        const [a, b, c] = groupActors;
        const group = (await replicas[0].chat.create(createContext(a, b, c))).affectedGroupId;
        for (const member of groupActors.slice(3, 11)) {
            await replicas[0].chat.invite(context(a, { groupId: group, target: entity(member.game) }));
        }
        const results = await Promise.allSettled(replicas.map((replica, index) =>
            replica.chat.invite(context(a, { groupId: group, target: entity(groupActors[11 + index].game) }))));
        assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
        assert.ok(code('LEGACY_CAPACITY')(results.find(result => result.status === 'rejected').reason));
        const rows = await members(group); assert.equal(rows.length, 12);
        assert.equal(rows.filter(row => String(row.accountId) === b.accountId).length, 2);
        assert.equal((await replicas[0].runtime.graph.access(b.accountId, c.accountId)).canWhisper, false);
    });

    await t.test('concurrent replacement claims fence previous sessions and preserve generations beyond Number precision', async () => {
        const [a, b, c] = await trio();
        const group = (await replicas[0].chat.create(createContext(a, b, c))).affectedGroupId;
        const generation = '9007199254740993';
        for (const model of [M.SocialLegacyOwner, M.SocialLegacyClaim, M.SocialLegacyMember]) {
            await model.update({ generation }, { where: { gameAccountId: a.gameId } });
        }
        a.generation = generation;
        const next = [await actor(a.accountId, a.gameId), await actor(a.accountId, a.gameId)];
        const results = await Promise.all(next.map((member, index) => subscribe(member, replicas[index])));
        assert.deepEqual(results.map(result => result.generation).sort(), ['9007199254740994', '9007199254740995']);
        const owner = await M.SocialLegacyOwner.findByPk(a.gameId, { raw: true });
        assert.equal(String(owner.generation), '9007199254740995');
        assert.equal(await M.SocialLegacyClaim.count({ where: { gameAccountId: a.gameId } }), 3);
        await assert.rejects(subscribe(a), code('LEGACY_STALE_SESSION'));
        await assert.rejects(replicas[0].chat.send(context(a, { groupId: group, text: 'stale owner' })), code('LEGACY_STALE_SESSION'));
        assert.equal((await snapshot(a)).groups.length, 0);
        const loser = next.find(member => member.owner.sessionKey !== owner.sessionKey);
        await assert.rejects(subscribe(loser), code('LEGACY_STALE_SESSION'));
        const winner = next.find(member => member.owner.sessionKey === owner.sessionKey);
        await subscribe(winner, replicas[1], '7');
        assert.equal(winner.generation, '9007199254740995');
        assert.equal((await members(group)).length, 0);
        assert.equal((await snapshot(b)).closed[0].remaining.gameAccountId.low.toString(), c.gameId);
        const another = await actor(a.accountId);
        await assert.rejects(replicas[0].chat.subscribe(context(winner, { gameAccountId: entity(another.game), objectId: '8' })), code('LEGACY_NOT_OWNER'));
    });

    await t.test('worker outages retain membership; explicit logout closes/frees slots with peer conversion before snapshot', async () => {
        const [a, b, c] = await trio();
        const group = (await replicas[0].chat.create(createContext(a, b, c))).affectedGroupId;
        const before = await snapshot(a);
        store.unavailable = true;
        try { await assert.rejects(replicas[1].chat.cleanup(100), /temporarily unavailable/); }
        finally { store.unavailable = false; }
        assert.equal((await members(group)).length, 3);
        assert.equal((await snapshot(a, replicas[1])).groups[0].groupId, group);
        store.rows.delete('/aurora/connections/' + c.connectionId);
        await replicas[1].chat.cleanup(100);
        assert.equal((await members(group)).length, 0);
        assert.equal(await M.SocialLegacyGroup.findByPk(group), null);
        assert.equal((await M.SocialLegacyOwner.findByPk(c.gameId, { raw: true })).active, 0);
        const after = await snapshot(a), other = await snapshot(b);
        assert.equal(after.closed[0].remaining.gameAccountId.low.toString(), b.gameId);
        assert.equal(other.closed[0].remaining.gameAccountId.low.toString(), a.gameId);
        const frames = replicas[0].chat.diff(before, after, { objectId: OBJECT });
        assert.deepEqual(frames.map(frame => frame.methodId), [3, 1]);
        assert.ok(frames.every(frame => frame.objectId === OBJECT));
        await replicas[0].chat.cleanup(100);
        assert.equal(await M.SocialLegacyClosed.count({ where: { groupId: group } }), 2, 'unconfirmed closures survive cleanup');
        await M.SocialSubscription.update({ snapshot: after }, { where: { accountId: a.accountId, kind: 'legacy' } });
        await replicas[0].chat.cleanup(100);
        assert.equal(await M.SocialLegacyClosed.count({ where: { groupId: group } }), 1);
    });

    await t.test('expiry cleanup paused on an old owner cannot delete a replacement generation and its new group', async () => {
        const [a, b, c] = await trio();
        await replicas[0].chat.create(createContext(a, b, c));
        store.rows.get('/aurora/connections/' + c.connectionId).expiresAt = store.now;
        const runtime = replicas[0].runtime, original = runtime.current;
        let arrive, release, paused = false;
        const arrived = new Promise(resolve => { arrive = resolve; });
        const released = new Promise(resolve => { release = resolve; });
        runtime.current = async (route, accountId) => {
            const result = await original.call(runtime, route, accountId);
            if (!paused && route.connectionId === c.connectionId) { paused = true; arrive(); await released; }
            return result;
        };
        const cleaning = replicas[0].chat.cleanup(100);
        let replacement, group;
        try {
            await Promise.race([arrived, cleaning.then(() => { throw new Error('Expected old-owner cleanup pause'); })]);
            replacement = await actor(c.accountId, c.gameId);
            await subscribe(replacement, replicas[1]);
            group = (await replicas[1].chat.create(createContext(a, b, replacement))).affectedGroupId;
        } finally { release(); runtime.current = original; await cleaning; }
        assert.equal((await members(group)).length, 3);
        const row = await M.SocialLegacyOwner.findByPk(c.gameId, { raw: true });
        assert.equal(row.active, 1); assert.equal(row.sessionKey, replacement.owner.sessionKey);
        assert.equal(String(row.generation), '2');
    });

    await t.test('opposite replica admission/block races serialize policy without deadlocking or bypassing pair blocks', async () => {
        for (const reverse of [false, true]) {
            const [a, b, c] = await trio(), d = await actor(); await subscribe(d); await friends(a, d);
            const group = (await replicas[0].chat.create(createContext(a, b, c))).affectedGroupId;
            const operations = [
                () => replicas[0].chat.invite(context(a, { groupId: group, target: entity(d.game) })),
                () => replicas[1].runtime.graph.block({ actorId: d.accountId, targetId: b.accountId, operationId: 'block-admission' })
            ];
            if (reverse) { operations.reverse(); }
            const results = await Promise.allSettled(operations.map(work => work()));
            assert.ok(results.every(result => result.status === 'fulfilled' || code('LEGACY_BLOCKED')(result.reason)));
            assert.equal((await replicas[1].runtime.graph.access(b.accountId, d.accountId)).blocked, true);
            await assert.rejects(replicas[0].chat.invite(context(a, { groupId: group, target: entity(d.game) })), code('LEGACY_BLOCKED'));
            const rows = await members(group);
            assert.ok(rows.length === 3 || rows.length === 4);
            if (rows.length === 4) {
                await assert.rejects(replicas[1].chat.send(context(a, { groupId: group, text: 'blocked pair' })), code('LEGACY_BLOCKED'));
            }
        }
    });

    await t.test('co-members receive public BattleTag and fenced active character without Real ID or friendship', async () => {
        const [a, b, c] = await trio(); await friends(a, c, 'real_id');
        const group = (await replicas[0].chat.create(createContext(a, b, c))).affectedGroupId;
        const owner = { version: 1, account_id: c.accountId, game_account_id: c.gameId, session_id: randomUUID(), generation: '9007199254741009',
            realm_uid: randomUUID(), namespace: 'test', instance_id: randomUUID(), pod_uid: randomUUID(),
            build: 15595, expansion: 3, address: '127.0.0.1' };
        await M.RealmProcessOwner.create({ realm_uid: owner.realm_uid, instance_id: owner.instance_id });
        await store.run(client => client.set('/skymist/v1/sessions/' + c.gameId, JSON.stringify(owner), { EX: 300 }));
        const character = { guid: '340282366920938463463374607431768211455', name: 'Current', realm_address: 50397185,
            realm_name: 'PublicRealm', level: 85, class: 8, race: 1, zone: 12, faction: 0 };
        await replicas[0].worldPresence.publish(owner, { sequence: '1', active: true, character });
        const project = async () => (await snapshot(b, replicas[1])).groups[0].members.find(member => member.gameAccountId.low.toString() === c.gameId);
        const projected = await project();
        assert.equal(projected.battleTag, 'Public#' + c.accountId); assert.equal(projected.activeCharacter.name, 'Current');
        assert.equal(projected.activeCharacter.guid, character.guid); assert.equal(projected.online, true);
        const type = loadProto(FILE).lookupType(NAMESPACE + 'LegacyMember');
        assert.equal(type.decode(type.encode(type.fromObject(projected)).finish()).activeCharacter.guid, character.guid);
        assert.equal(JSON.stringify(projected).includes('Private'), false);
        assert.equal((await replicas[0].runtime.graph.access(b.accountId, c.accountId)).canWhisper, false);
        await replicas[1].worldPresence.publish(owner, { sequence: '2', active: true, character: { ...character, name: 'Changed' } });
        assert.equal((await project()).activeCharacter.name, 'Changed');
        assert.equal((await members(group)).length, 3);
        await M.RealmProcessOwner.update({ instance_id: randomUUID() }, { where: { realm_uid: owner.realm_uid } });
        assert.equal((await project()).activeCharacter, undefined, 'retired world publisher cannot expose an old character');
        await replicas[0].chat.leave(context(a, { groupId: group }));
        const remaining = (await snapshot(b)).closed[0].remaining;
        assert.equal(remaining.battleTag, projected.battleTag);
        assert.equal(remaining.activeCharacter, undefined); assert.equal(remaining.online, undefined);
    });

    await t.test('session blocks gate admission and live send without closing groups; SQL/Redis retain only metadata', async () => {
        const [a, b, c] = await trio(), d = await actor(); await subscribe(d); await friends(a, d);
        const runtime = replicas[0].runtime;
        await runtime.blockSession(b.owner, c.accountId);
        await assert.rejects(replicas[1].chat.create(createContext(a, b, c)), code('LEGACY_BLOCKED'));
        await runtime.unblockSession(b.owner, c.accountId);
        const group = (await replicas[0].chat.create(createContext(a, b, c))).affectedGroupId;
        for (const [blocker, target] of [[b, d], [d, b]]) {
            await runtime.blockSession(blocker.owner, target.accountId);
            await assert.rejects(replicas[1].chat.invite(context(a, { groupId: group, target: entity(d.game) })), code('LEGACY_BLOCKED'));
            await runtime.unblockSession(blocker.owner, target.accountId);
        }
        const secret = 'legacy-sql-private-message-' + randomUUID(), send = context(a, { groupId: group, text: secret });
        await runtime.blockSession(c.owner, b.accountId);
        await assert.rejects(replicas[1].chat.send(send), code('LEGACY_BLOCKED'));
        await replicas[1].chat.cleanup(100);
        assert.equal((await members(group)).length, 3);
        await runtime.unblockSession(c.owner, b.accountId);
        const before = deliveries.length;
        await replicas[0].chat.send(send); await replicas[1].chat.send(send);
        assert.equal(deliveries.length - before, 3);
        const uncertain = context(a, { groupId: group, text: secret + '-uncertain' });
        runtime.uncertain = true;
        try { await assert.rejects(replicas[0].chat.send(uncertain), code('LEGACY_SEND_UNCONFIRMED')); }
        finally { runtime.uncertain = false; }
        await assert.rejects(replicas[1].chat.send(uncertain), code('LEGACY_SEND_UNCONFIRMED'));
        assert.equal(deliveries.length - before, 4);
        for (const [name, model] of Object.entries(M)) {
            if (!name.startsWith('Social')) { continue; }
            assert.equal(JSON.stringify(await model.findAll({ raw: true })).includes(secret), false, name);
            if (name.startsWith('SocialLegacy')) {
                assert.equal(Object.keys(model.rawAttributes).some(field => /text|message|history/i.test(field)), false);
            }
        }
        assert.equal(JSON.stringify([...store.rows]).includes(secret), false);
        const claims = [...store.rows].filter(([key]) => key.startsWith('/skymist/v1/social/legacy/send/'));
        assert.equal(claims.length, 2);
        for (const [, row] of claims) { assert.deepEqual(Object.keys(JSON.parse(row.value)).sort(), ['hash', 'state']); }
        assert.ok(claims.every(([, row]) => row.expiresAt === store.now + LIMITS.dedupSeconds * 1000));
        await runtime.graph.block({ actorId: b.accountId, targetId: c.accountId, operationId: 'durable-block' });
        await assert.rejects(replicas[1].chat.send(context(a, { groupId: group, text: 'blocked pair' })), code('LEGACY_BLOCKED'));
        assert.equal((await members(group)).length, 3);
    });

    // Exercise reversible migration teardown/recreate only inside this unique test DB.
    await t.test('runtime, presence and legacy down/up recreate the matching schema', async () => {
        for (const name of migrations.slice(1, 4).reverse()) {
            await require('../migrations/' + name).down(sequelize.getQueryInterface(), DataTypes);
        }
        for (const name of migrations.slice(1, 4)) {
            await require('../migrations/' + name).up(sequelize.getQueryInterface(), DataTypes);
        }
        for (const [name, model] of Object.entries(M)) {
            if (/^SocialLegacy|^SocialSubscription$|^SocialPresenceState$/.test(name)) { assert.equal(await model.count(), 0); }
        }
        assert.equal(await M.SocialLegacyMember.count({ where: { gameAccountId: { [Op.gt]: '0' } } }), 0);
    });
});
