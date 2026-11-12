'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { EventEmitter } = require('node:events');
const { Op } = require('sequelize');
const SocialRuntime = require('../social/runtime');
const { SocialSession } = require('../social/session');

const A = '9007199254740993', B = '9007199254740995', C = '9007199254740997';
const G = '9007199254741001', G2 = '9007199254741003';
const OBJECT = '18446744073709551615';
const clone = value => structuredClone(value);
const frame = text => ({ serviceHash: 1, worldHash: 2, methodId: 3, objectId: OBJECT, payload: Buffer.from(text) });

function fixture(t, extra = {}) {
    const account = { id: A, credentialVersion: '3', authenticatorGeneration: '2', authenticatorState: 2, realIdEnabled: true };
    const verified = Math.floor(Date.now() / 1000) - 60;
    const connection = { accountId: A, address: '127.0.0.1', applicationVersion: 26972,
        credentialVersion: '3', authenticatorGeneration: '2', authenticatorVerifiedAt: verified };
    const world = { version: 1, account_id: A, game_account_id: G, session_id: '5e55e55e-0000-4000-8000-000000000001', generation: '9007199254741011',
        namespace: 'test', realm_uid: '5e55e55e-0000-4000-8000-000000000002', pod_uid: '5e55e55e-0000-4000-8000-000000000003',
        instance_id: '5e55e55e-0000-4000-8000-000000000004', build: 26972, expansion: 6, address: '127.0.0.1',
        credential_version: '3', authenticator_generation: '2', authenticator_verified_at: verified };
    const connectionRoute = { type: 'connection', connectionId: 'first', address: connection.address, queueName: 'connection-queue' };
    const worldRoute = { type: 'world', owner: { ...clone(world), routeEpoch: '1' }, queueName: 'world-queue' };
    const state = {
        account, connection, world,
        accounts: new Map([[A, account], [B, { id: B, battleTag: 'Peer#1234' }], [C, { id: C, battleTag: 'Other#1234' }]]),
        games: new Map([[G, { id: G, accountId: A, program: 'WoW', expansion: 6 }], [G2, { id: G2, accountId: A, program: 'WoW', expansion: 6 }]]),
        process: { realm_uid: world.realm_uid, instance_id: world.instance_id },
        redis: new Map([['/aurora/connections/first', JSON.stringify(connection)], ['/skymist/v1/sessions/' + G, JSON.stringify(world)]]),
        ttl: new Map([['/aurora/connections/first', 300000]]), commands: [], warnings: [], sent: [], queries: [],
        tables: { SocialSubscription: new Map(), SocialSessionBlock: new Map(), SocialBlock: new Map(),
            SocialWorldRoute: new Map([['route-1', { id: 'route-1', sessionKey: 'w:' + world.session_id + ':' + world.generation,
                accountId: A, gameAccountId: G, routeEpoch: '1', route: clone(worldRoute) }]]) }, locks: new Map(),
        accountError: null, ipError: null, outboxError: null, onSend: null, publicationError: null
    };
    function matches(row, where = {}) {
        return Reflect.ownKeys(where).every(key => {
            if (key === Op.or) { return where[key].some(part => matches(row, part)); }
            const value = where[key];
            if (value && typeof value === 'object' && !(value instanceof Date)) {
                if (Op.in in value) { return value[Op.in].includes(row[key]); }
                if (Op.gt in value) { return row[key] > value[Op.gt]; }
                if (Op.lt in value) { return row[key] < value[Op.lt]; }
                throw new Error('Unimplemented controlled predicate');
            }
            return row[key] === value;
        });
    }
    function rows(name, transaction) {
        const result = new Map(state.tables[name]);
        for (const [id, value] of transaction?.writes[name] || []) {
            if (value === null) { result.delete(id); } else { result.set(id, value); }
        }
        return result;
    }
    async function lock(key, transaction, skip = false) {
        if (!transaction) { return true; }
        while (state.locks.has(key) && state.locks.get(key) !== transaction) {
            if (skip) { return false; }
            await state.locks.get(key).done;
        }
        state.locks.set(key, transaction);
        return true;
    }
    const sequelize = { transaction: async (options, work) => {
        if (typeof options === 'function') { work = options; }
        let release;
        const transaction = { LOCK: { UPDATE: 'UPDATE' }, writes: Object.fromEntries(Object.keys(state.tables).map(name => [name, new Map()])),
            done: new Promise(resolve => { release = resolve; }) };
        try {
            const result = await work(transaction);
            for (const [name, changes] of Object.entries(transaction.writes)) {
                for (const [id, value] of changes) {
                    if (value === null) { state.tables[name].delete(id); } else { state.tables[name].set(id, value); }
                }
            }
            return result;
        }
        finally {
            for (const [key, owner] of state.locks) { if (owner === transaction) { state.locks.delete(key); } }
            release();
        }
    } };
    const models = {
        sequelize, ipBansEnabled: false,
        Account: {
            findByPk: async (id, query = {}) => {
                if (state.accountError) { throw state.accountError; }
                if (query.lock) { await lock('account:' + id, query.transaction); }
                return clone(state.accounts.get(id) || null);
            },
            findAll: async query => [...state.accounts.values()].filter(row => matches(row, query.where)).slice(0, query.limit).map(clone)
        },
        GameAccount: { findByPk: async id => clone(state.games.get(id) || null) },
        RealmProcessOwner: { findByPk: async () => clone(state.process) },
        IPBan: { findOne: async () => { if (state.ipError) { throw state.ipError; } return state.ipBan || null; } }
    };
    for (const name of Object.keys(state.tables)) {
        const instance = row => ({ ...clone(row), get: () => clone(row) });
        const model = models[name] = {};
        model.findAll = async (query = {}) => {
            state.queries.push({ name, query });
            let found = [...rows(name, query.transaction).values()].filter(row => matches(row, query.where));
            if (query.group) { found = [...new Map(found.map(row => [JSON.stringify(query.group.map(key => row[key])), row])).values()]; }
            if (query.order) { found.sort((a, b) => String(a[query.order[0][0]]).localeCompare(String(b[query.order[0][0]]))); }
            if (query.limit !== undefined) { found = found.slice(0, query.limit); }
            return found.map(row => query.raw ? clone(row) : instance(row));
        };
        model.findOne = async query => {
            const found = (await model.findAll({ ...query, raw: true, limit: 1 }))[0];
            if (!found) { return null; }
            if (query.lock && !await lock(name + ':' + found.id, query.transaction, query.skipLocked)) { return null; }
            const row = rows(name, query.transaction).get(found.id);
            if (!row || !matches(row, query.where)) { return null; }
            return query.raw ? clone(row) : instance(row);
        };
        model.count = async query => [...rows(name, query.transaction).values()].filter(row => matches(row, query.where)).length;
        model.create = async (values, query) => {
            assert.ok(query.transaction);
            query.transaction.writes[name].set(values.id, clone(values));
            return instance(values);
        };
        model.update = async (values, query) => {
            if (!query.transaction) { return sequelize.transaction(transaction => model.update(values, { ...query, transaction })); }
            const found = [...rows(name, query.transaction).values()].filter(row => matches(row, query.where));
            let updated = 0;
            for (const row of found) {
                await lock(name + ':' + row.id, query.transaction);
                // SQL UPDATE applies SET columns to the row visible after acquiring its lock.
                const current = rows(name, query.transaction).get(row.id);
                if (!current || !matches(current, query.where)) { continue; }
                query.transaction.writes[name].set(row.id, { ...current, ...clone(values) });
                updated++;
            }
            return [updated];
        };
        model.destroy = async query => {
            if (!query.transaction) { return sequelize.transaction(transaction => model.destroy({ ...query, transaction })); }
            const found = [...rows(name, query.transaction).values()].filter(row => matches(row, query.where)).slice(0, query.limit);
            for (const row of found) {
                await lock(name + ':' + row.id, query.transaction);
                query.transaction.writes[name].set(row.id, null);
            }
            return found.length;
        };
    }
    const client = { get: async key => state.redis.get(key) || null, pTTL: async key => state.ttl.get(key) ?? -2,
        getEx: async key => {
            const raw = state.redis.get(key);
            if (raw) { state.ttl.set(key, 300000); }
            return raw || null;
        } };
    let previousRedis = Promise.resolve();
    const store = {
        run: async work => work(client),
        transaction: async (keys, work) => {
            const previous = previousRedis;
            let release; previousRedis = new Promise(resolve => { release = resolve; });
            await previous;
            try {
                const decision = await work(client);
                for (const command of decision.commands) {
                    state.commands.push(command);
                    assert.deepEqual(command.slice(3), ['XX', 'KEEPTTL']);
                    if (state.redis.has(command[1])) { state.redis.set(command[1], command[2]); }
                }
                return decision.result;
            }
            finally { release(); }
        }
    };
    const channel = kind => {
        const value = new EventEmitter();
        value.sendToQueue = (queue, payload, options, confirm) => {
            state.sent.push({ kind, queue, payload, options });
            state.onSend?.();
            confirm(state.publicationError);
            return true;
        };
        value.close = async () => {};
        return value;
    };
    const dependencies = { models, store, logger: { warn: value => state.warnings.push(value) }, ...extra };
    const runtime = new SocialRuntime(dependencies);
    runtime.channel = channel('connection'); runtime.realmChannel = channel('world');
    runtime.graph = {
        pendingOutbox: async () => { if (state.outboxError) { throw state.outboxError; } return []; }, acknowledgeOutbox: async () => {}
    };
    t.after(() => { runtime.stopping = true; clearTimeout(runtime.timer); });
    const owner = () => runtime.session({ identity: { connectionId: 'first', address: connection.address }, queueName: connectionRoute.queueName });
    const addSubscription = (route = connectionRoute, extra = {}) => {
        const row = { id: 'row-1', sessionKey: route.type === 'world' ? 'w:' + world.session_id + ':' + world.generation : 'c:first',
            gameAccountId: route.type === 'world' ? G : null,
            accountId: A, kind: 'test', target: A, objectId: OBJECT, route: clone(route), filter: {}, snapshot: { value: 'old' },
            ready: true, expiresAt: new Date(Date.now() + 300000), ...extra };
        state.tables.SocialSubscription.set(row.id, clone(row));
        return row;
    };
    return { runtime, state, models, store, dependencies, worldRoute, connectionRoute, owner, addSubscription };
}

test('current world owner requires process, game ownership and correctly mapped authenticator proof', async t => {
    const f = fixture(t);
    const owner = await f.runtime.current(f.worldRoute, A);
    assert.equal(owner.gameAccountId, G);
    assert.equal(owner.credentialVersion, '3'); assert.equal(owner.authenticatorGeneration, '2');
    assert.equal(owner.authenticatorVerifiedAt, f.state.world.authenticator_verified_at);
    const process = f.state.process;
    f.state.process = null; assert.equal(await f.runtime.current(f.worldRoute, A), null);
    f.state.process = { ...process, instance_id: '5e55e55e-0000-4000-8000-0000000000ff' }; assert.equal(await f.runtime.current(f.worldRoute, A), null);
    f.state.process = process;
    f.state.games.get(G).accountId = B; assert.equal(await f.runtime.current(f.worldRoute, A), null);
    f.state.games.get(G).accountId = A;
    f.state.games.get(G).isBanned = true; assert.equal(await f.runtime.current(f.worldRoute, A), null);
    f.state.games.get(G).isBanned = false;
    f.state.account.credentialVersion = '4'; assert.equal(await f.runtime.current(f.worldRoute, A), null);
    f.state.account.credentialVersion = '3';
    f.state.redis.set('/skymist/v1/sessions/' + G, JSON.stringify({ ...f.state.world, authenticator_verified_at: '123' }));
    assert.equal(await f.runtime.current(f.worldRoute, A), null);
});

test('connection revocation and IP bans reject, while dependency errors retain recoverable session state', async t => {
    const f = fixture(t);
    assert.ok(await f.runtime.current(f.connectionRoute, A));
    f.state.account.authenticatorGeneration = '3'; assert.equal(await f.runtime.current(f.connectionRoute, A), null);
    f.state.account.authenticatorGeneration = '2';
    f.models.ipBansEnabled = true;
    f.state.ipBan = { expiresAt: null }; assert.equal(await f.runtime.current(f.connectionRoute, A), null);
    f.state.ipBan = null;
    f.state.ipError = new Error('Authentication database temporarily unavailable');
    await assert.rejects(f.runtime.current(f.connectionRoute, A), error => error === f.state.ipError);
    assert.ok(f.state.redis.has('/aurora/connections/first'));
});

test('notify fences world generation and connection loss between frames and preserves full object IDs', async t => {
    const f = fixture(t);
    const row = f.addSubscription(f.worldRoute);
    assert.equal(await f.runtime.notify(row, [frame('hello')]), true);
    const sent = f.state.sent[0]; const payload = JSON.parse(sent.payload.toString());
    assert.equal(sent.kind, 'world'); assert.equal(sent.queue, 'world-queue');
    assert.equal(payload.generation, f.state.world.generation); assert.equal(payload.object_id, OBJECT);
    assert.equal(payload.game_account_id, G); assert.equal(payload.service_hash, 2);
    f.state.redis.set('/skymist/v1/sessions/' + G, JSON.stringify({ ...f.state.world, generation: '2' }));
    assert.equal(await f.runtime.notify(row, [frame('stale')]), false);
    assert.equal(f.state.sent.length, 1);
    f.state.sent.length = 0;
    f.state.onSend = () => f.state.redis.delete('/aurora/connections/first');
    assert.equal(await f.runtime.notify(f.addSubscription(), [frame('first'), frame('second')]), false);
    assert.equal(f.state.sent.length, 1);
});

test('world notifications cap decoded protobuf payloads at 65536 bytes while direct connections retain 262144', async t => {
    const f = fixture(t);
    const world = f.addSubscription(f.worldRoute);
    assert.equal(await f.runtime.notify(world, [{ ...frame(''), payload: Buffer.alloc(65536) }]), true);
    assert.equal(Buffer.from(JSON.parse(f.state.sent[0].payload).payload, 'base64').length, 65536);
    await assert.rejects(f.runtime.notify(world, [{ ...frame(''), payload: Buffer.alloc(65537) }]), /exceeds limit/);
    assert.equal(f.state.sent.length, 1);
    const connection = f.addSubscription();
    assert.equal(await f.runtime.notify(connection, [{ ...frame(''), payload: Buffer.alloc(262144) }]), true);
    await assert.rejects(f.runtime.notify(connection, [{ ...frame(''), payload: Buffer.alloc(262145) }]), /exceeds limit/);
    assert.equal(f.state.sent.length, 2);
});

test('Subscribe ready gate belongs to the exact response attempt, including concurrent replacements', async t => {
    const f = fixture(t); f.runtime.register('test', { snapshot: async () => ({}), diff: () => [] });
    const owner = await f.owner(); const first = {}, second = {};
    const original = await f.runtime.subscribe(first, owner, 'test', A, OBJECT, {}, { version: 1 });
    assert.equal(f.state.tables.SocialSubscription.get(original.id).ready, false);
    const replacement = await f.runtime.subscribe(second, owner, 'test', A, OBJECT, {}, { version: 2 });
    assert.notEqual(replacement.id, original.id);
    await first.afterReply();
    assert.equal(f.state.tables.SocialSubscription.get(replacement.id).ready, false);
    await second.afterReply();
    assert.equal(f.state.tables.SocialSubscription.get(replacement.id).ready, true);
    assert.equal(f.state.tables.SocialSubscription.size, 1);
});

test('privacy changes are projected without a graph revision change and confirmed before saving the snapshot', async t => {
    const f = fixture(t); const row = f.addSubscription(undefined, { snapshot: { name: 'Private' } });
    f.runtime.register('test', { snapshot: async () => ({ name: f.state.account.realIdEnabled ? 'Private' : '' }),
        diff: (before, after) => [frame(JSON.stringify(after))] });
    f.state.account.realIdEnabled = false;
    f.state.publicationError = new Error('Broker confirmation failed');
    await assert.rejects(f.runtime.reconcileRow(row.id), /Broker confirmation failed/);
    assert.deepEqual(f.state.tables.SocialSubscription.get(row.id).snapshot, { name: 'Private' });
    f.state.publicationError = null;
    await f.runtime.reconcileRow(row.id);
    assert.deepEqual(f.state.tables.SocialSubscription.get(row.id).snapshot, { name: '' });
    assert.ok(f.state.sent.every(sent => !sent.payload.toString().includes('Private')));
});

test('two replicas serialize subscription diffs and do not resend an already confirmed snapshot', async t => {
    const f = fixture(t), replica = new SocialRuntime(f.dependencies);
    replica.channel = f.runtime.channel; replica.realmChannel = f.runtime.realmChannel;
    const row = f.addSubscription();
    let enter, release;
    const entered = new Promise(resolve => { enter = resolve; });
    const paused = new Promise(resolve => { release = resolve; });
    const projection = { snapshot: async () => { enter(); await paused; return { value: 'new' }; }, diff: () => [frame('new')] };
    f.runtime.register('test', projection); replica.register('test', projection);
    const first = f.runtime.reconcileRow(row.id);
    await entered;
    await replica.reconcileRow(row.id); // SKIP LOCKED: another replica owns this subscription.
    release(); await first;
    await replica.reconcileRow(row.id);
    assert.equal(f.state.sent.length, 1);
});

test('session lost during projection removes the subscription instead of recording undelivered state', async t => {
    const f = fixture(t), row = f.addSubscription();
    f.runtime.register('test', { snapshot: async () => {
        f.state.redis.delete('/aurora/connections/first'); return { value: 'new' };
    }, diff: () => [frame('new')] });
    await f.runtime.reconcileRow(row.id);
    assert.equal(f.state.tables.SocialSubscription.has(row.id), false);
    assert.equal(f.state.sent.length, 0);
});

test('social dependency failure preserves session ownership, subscriptions and runtime retryability', async t => {
    const f = fixture(t); const row = f.addSubscription();
    f.state.outboxError = new Error('SQL unavailable');
    const session = f.state.redis.get('/skymist/v1/sessions/' + G);
    await assert.rejects(f.runtime.pulse(), /SQL unavailable/);
    assert.equal(f.state.redis.get('/skymist/v1/sessions/' + G), session);
    assert.equal(f.runtime.stopping, false); assert.equal(f.runtime.channelFailed, undefined);
    assert.ok(f.state.tables.SocialSubscription.has(row.id));
    f.state.outboxError = null;
    f.runtime.register('test', { snapshot: async () => ({ value: 'recovered' }), diff: () => [frame('recovered')] });
    await f.runtime.pulse();
    assert.equal(f.state.sent.length, 1);
});

test('session blocks are idempotent, isolated to their owning license/session and survive worker recreation', async t => {
    const f = fixture(t); const owner = await f.owner();
    assert.equal(await owner.blockForSession(B), true);
    assert.equal(await owner.blockForSession(B), false);
    assert.equal(await f.runtime.sessionBlocked(owner.sessionKey, B), true);
    assert.equal(await f.runtime.sessionBlocked('c:second', B), false);
    assert.deepEqual(await owner.sessionBlocks(), [{ accountId: B, battleTag: 'Peer#1234' }]);
    const replica = new SocialRuntime(f.dependencies);
    assert.equal(await replica.sessionBlocked(owner.sessionKey, B), true);
    assert.equal(f.state.tables.SocialSessionBlock.size, 1);
    await assert.rejects(owner.blockForSession(A), value => value === 0x1F42);
    assert.equal(await owner.unblockForSession(B), true);
    assert.equal(await owner.unblockForSession(B), false);
    assert.equal(await f.runtime.sessionBlocked(owner.sessionKey, B), false);
});

test('session block capacity serializes concurrent requests and cleanup deletes only invalid owners', async t => {
    const f = fixture(t), owner = await f.owner();
    for (let i = 0; i < 99; i++) {
        const id = String(i).padStart(36, '0');
        f.state.tables.SocialSessionBlock.set(id, { id, accountId: A, sessionKey: owner.sessionKey,
            blockedAccountId: String(1000 + i), route: owner.route, createdAt: new Date() });
    }
    const results = await Promise.allSettled([B, C].map(target => owner.blockForSession(target)));
    assert.equal(results.filter(value => value.status === 'fulfilled').length, 1);
    assert.equal(results.find(value => value.status === 'rejected').reason, 0x1F45);
    await f.runtime.cleanupSessionBlocks(20);
    assert.equal(f.state.tables.SocialSessionBlock.size, 100);
    f.state.redis.delete('/aurora/connections/first');
    await f.runtime.cleanupSessionBlocks(20);
    assert.equal(f.state.tables.SocialSessionBlock.size, 80);
    const winner = results[0].status === 'fulfilled' ? B : C;
    assert.equal(await f.runtime.sessionBlocked(owner.sessionKey, winner), false);
});

test('selectGame binds exactly one canonical license atomically and preserves the identity TTL and proof', async t => {
    const f = fixture(t), owner = await f.owner();
    const key = '/aurora/connections/first'; f.state.ttl.set(key, 12345);
    const results = await Promise.allSettled([G, G2].map(gameId => f.runtime.selectGame({ ...owner }, gameId)));
    assert.equal(results.filter(value => value.status === 'fulfilled').length, 1);
    assert.equal(results.find(value => value.status === 'rejected').reason, 0xA);
    const selected = results.find(value => value.status === 'fulfilled').value.gameAccountId;
    assert.equal(f.state.ttl.get(key), 12345);
    assert.equal(JSON.parse(f.state.redis.get(key)).credentialVersion, '3');
    assert.deepEqual(f.state.commands[0].slice(3), ['XX', 'KEEPTTL']);
    assert.equal((await f.owner()).gameAccountId, selected);
    assert.equal((await f.runtime.selectGame(owner, selected)).gameAccountId, selected);
    assert.equal(owner.gameAccountId, selected);
    assert.equal(f.state.commands.length, 1);
});

test('selectGame rejects foreign/revoked/expired connections and cannot change a world license', async t => {
    const f = fixture(t), owner = await f.owner();
    f.state.games.get(G).accountId = B;
    await assert.rejects(f.runtime.selectGame(owner, G), value => value === 0xA);
    f.state.games.get(G).accountId = A;
    f.state.account.credentialVersion = '4';
    await assert.rejects(f.runtime.selectGame(owner, G), value => value === 0xA);
    f.state.account.credentialVersion = '3';
    f.state.ttl.set('/aurora/connections/first', 0);
    await assert.rejects(f.runtime.selectGame(owner, G), value => value === 0xA);
    const world = await f.runtime.current(f.worldRoute, A);
    assert.equal((await f.runtime.selectGame(world, G)).gameAccountId, G);
    await assert.rejects(f.runtime.selectGame(world, G2), value => value === 0xA);
    assert.equal(f.state.commands.length, 0);
});

test('legal graph-size snapshots fit recovery while oversized snapshots are rejected before becoming ready', async t => {
    const f = fixture(t), owner = await f.owner();
    const snapshot = { friends: Array.from({ length: 200 }, (_, n) => ({ accountId: String(n + 1), note: 'n'.repeat(1024) })),
        receivedInvitations: Array.from({ length: 100 }, (_, n) => ({ invitationId: String(n + 1), message: 'm'.repeat(1024) })) };
    assert.ok(Buffer.byteLength(JSON.stringify(snapshot)) > 262144);
    f.runtime.register('test', { snapshot: async () => snapshot, diff: () => [] });
    const context = {};
    const row = await f.runtime.subscribe(context, owner, 'test', A, OBJECT, {}, snapshot);
    await context.afterReply();
    await f.runtime.reconcileRow(row.id);
    assert.deepEqual(f.state.tables.SocialSubscription.get(row.id).snapshot, snapshot);
    await assert.rejects(f.runtime.subscribe({}, owner, 'test', A, '2', {}, { data: 'x'.repeat(4 * 1024 * 1024) }), value => value === 0xBC5);
    assert.equal(f.state.tables.SocialSubscription.size, 1);
});

test('broker failure between frames stops the batch and does not change world-session ownership', async t => {
    const f = fixture(t), row = f.addSubscription();
    const world = f.state.redis.get('/skymist/v1/sessions/' + G);
    f.state.onSend = () => { f.runtime.channelFailed = true; };
    await assert.rejects(f.runtime.notify(row, [frame('one'), frame('two')]), /channel unavailable/);
    assert.equal(f.state.sent.length, 1);
    assert.equal(f.state.redis.get('/skymist/v1/sessions/' + G), world);
    f.runtime.channelFailed = false; f.state.onSend = null;
    f.runtime.channel.sendToQueue = () => { throw new Error('Channel closed synchronously'); };
    await assert.rejects(f.runtime.notify(row, [frame('one')]), /Channel closed synchronously/);
});

test('session block cleanup preserves valid blocks through dependency failure and ignores forged session owners', async t => {
    const f = fixture(t), owner = await f.owner();
    await owner.blockForSession(B);
    f.state.accountError = new Error('SQL unavailable');
    await assert.rejects(f.runtime.cleanupSessionBlocks(), /SQL unavailable/);
    assert.equal(f.state.tables.SocialSessionBlock.size, 1);
    await assert.rejects(f.runtime.sessionBlocked(owner.sessionKey, B), /SQL unavailable/);
    f.state.accountError = null;
    await assert.rejects(f.runtime.unblockSession({ ...owner, sessionKey: 'c:other' }, B), value => value === 0xA);
    await assert.rejects(f.runtime.blockSession({ ...owner, accountId: C }, B), value => value === 0xA);
    await assert.rejects(f.runtime.sessionBlocked({ any: true }, B), value => value === 0x7);
    assert.equal(await f.runtime.sessionBlocked(owner.sessionKey, B), true);
    f.state.redis.delete('/aurora/connections/first');
    await f.runtime.cleanupSessionBlocks();
    assert.equal(f.state.tables.SocialSessionBlock.size, 0);
});

test('session block migration is additive and retains rows until authenticated session cleanup', async () => {
    const migration = require('../migrations/20261112000006-session-social-blocks');
    const queries = [];
    await migration.up({ sequelize: { query: async sql => queries.push(sql) } });
    assert.equal(queries.length, 1);
    assert.match(queries[0], /UNIQUE KEY social_session_block_identity \(session_key, blocked_account_id\)/);
    assert.match(queries[0], /FOREIGN KEY \(account_id\) REFERENCES accounts\(id\)/);
    await assert.rejects(migration.down(), /authenticated session cleanup/);
});

test('world route fence persists without subscriptions, compares uint64 epochs exactly and survives replicas', async t => {
    const f = fixture(t);
    f.state.tables.SocialWorldRoute.clear();
    const owner = { ...f.state.world, routeEpoch: '9007199254740993' };
    const result = await f.runtime.refreshWorldRoute(owner, 'queue-one');
    assert.deepEqual(result, { changed: true, sessionKey: 'w:' + owner.session_id + ':' + owner.generation,
        routeEpoch: owner.routeEpoch, queueName: 'queue-one' });
    assert.equal(f.state.tables.SocialSubscription.size, 0);
    const replica = new SocialRuntime(f.dependencies);
    assert.equal((await replica.refreshWorldRoute(owner, 'queue-one')).changed, false);
    await assert.rejects(replica.refreshWorldRoute(owner, 'queue-other'), value => value === 0xA);
    await assert.rejects(replica.refreshWorldRoute({ ...owner, routeEpoch: '9007199254740992' }, 'queue-old'), value => value === 0xA);
    assert.equal((await replica.refreshWorldRoute({ ...owner, routeEpoch: OBJECT }, 'queue-max')).changed, true);
    assert.equal([...f.state.tables.SocialWorldRoute.values()][0].routeEpoch, OBJECT);
    for (const routeEpoch of [undefined, 1, 1n, '0', '01', '+1', '1e3', '-1', '18446744073709551616']) {
        await assert.rejects(replica.refreshWorldRoute({ ...owner, routeEpoch }, 'queue'), value => value === 0xBC5);
    }
    assert.equal([...f.state.tables.SocialWorldRoute.values()][0].route.queueName, 'queue-max');
});

test('world refresh migrates only the matching parent/license/session and resets only presence snapshots', async t => {
    const f = fixture(t);
    for (const kind of ['friends', 'blocks', 'presence']) { f.addSubscription(f.worldRoute, { id: kind, kind }); }
    f.addSubscription(f.worldRoute, { id: 'pending', kind: 'presence', ready: false });
    f.addSubscription(f.worldRoute, { id: 'other-game', gameAccountId: G2 });
    f.addSubscription(f.worldRoute, { id: 'other-parent', accountId: B });
    f.addSubscription(f.worldRoute, { id: 'other-session', sessionKey: 'w:other:1' });
    const direct = f.addSubscription(f.connectionRoute, { id: 'direct' });
    const owner = { ...f.state.world, routeEpoch: '2' };
    await f.runtime.refreshWorldRoute(owner, 'queue-new');
    for (const name of ['friends', 'blocks', 'presence', 'pending']) {
        const row = f.state.tables.SocialSubscription.get(name);
        assert.equal(row.route.queueName, 'queue-new'); assert.equal(row.route.owner.routeEpoch, '2');
        assert.equal(row.ready, name !== 'pending');
        assert.deepEqual(row.snapshot, ['presence', 'pending'].includes(name) ? null : { value: 'old' });
    }
    for (const name of ['other-game', 'other-parent', 'other-session']) {
        assert.equal(f.state.tables.SocialSubscription.get(name).route.queueName, 'world-queue');
    }
    assert.deepEqual(f.state.tables.SocialSubscription.get('direct'), direct);
    const context = {}; f.runtime.worldContext(context, owner, 'queue-new');
    const principal = await f.runtime.session(context);
    assert.equal(principal.routeEpoch, '2'); assert.equal(principal.route.owner.routeEpoch, '2');
    assert.equal((await f.runtime.current(principal.route, A)).routeEpoch, '2');
    assert.equal(await f.runtime.notify(f.addSubscription(f.worldRoute, { id: 'stale-copy' }), [frame('old')]), false);
    f.runtime.register('presence', { snapshot: async () => ({ online: true }), diff: previous => {
        assert.equal(previous, null); return [frame('join')];
    } });
    await f.runtime.reconcileRow('presence');
    assert.equal(f.state.sent[0].queue, 'queue-new');
    // A same-epoch heartbeat must not keep resetting the healed presence baseline.
    assert.equal((await f.runtime.refreshWorldRoute(owner, 'queue-new')).changed, false);
    assert.deepEqual(f.state.tables.SocialSubscription.get('presence').snapshot, { online: true });
});

test('late world Subscribe, Unsubscribe and afterReply cannot roll back or ready a refreshed route', async t => {
    const f = fixture(t), context = {};
    f.runtime.register('friends', { snapshot: async () => ({}), diff: () => [] });
    f.runtime.worldContext(context, f.worldRoute.owner, f.worldRoute.queueName);
    const old = await f.runtime.session(context);
    const row = await f.runtime.subscribe(context, old, 'friends', A, OBJECT, {}, { friends: [] });
    await f.runtime.refreshWorldRoute({ ...f.state.world, routeEpoch: '2' }, 'queue-new');
    await context.afterReply();
    assert.equal(f.state.tables.SocialSubscription.get(row.id).ready, false);
    await assert.rejects(f.runtime.subscribe({}, old, 'friends', A, OBJECT), value => value === 0xA);
    await assert.rejects(f.runtime.unsubscribe(old, 'friends'), value => value === 0xA);
    assert.equal(f.state.tables.SocialSubscription.get(row.id).route.queueName, 'queue-new');
    const nextContext = {};
    f.runtime.worldContext(nextContext, { ...f.state.world, routeEpoch: '2' }, 'queue-new');
    const next = await f.runtime.subscribe(nextContext, await f.runtime.session(nextContext), 'friends', A, OBJECT);
    await nextContext.afterReply();
    assert.equal(f.state.tables.SocialSubscription.get(next.id).ready, true);
    assert.equal(f.state.tables.SocialSubscription.size, 1);
});

test('simultaneous world route replacements serialize across replicas and never lower the stored epoch', async t => {
    const f = fixture(t), replica = new SocialRuntime(f.dependencies);
    const results = await Promise.allSettled([
        replica.refreshWorldRoute({ ...f.state.world, routeEpoch: '10' }, 'queue-10'),
        f.runtime.refreshWorldRoute({ ...f.state.world, routeEpoch: '9' }, 'queue-9')
    ]);
    assert.equal(results[0].status, 'fulfilled');
    assert.equal(results[1].status, 'rejected'); assert.equal(results[1].reason, 0xA);
    assert.equal([...f.state.tables.SocialWorldRoute.values()][0].routeEpoch, '10');
    const equal = await Promise.allSettled(['a', 'b'].map(queue => replica.refreshWorldRoute({ ...f.state.world, routeEpoch: '11' }, queue)));
    assert.equal(equal.filter(result => result.status === 'fulfilled').length, 1);
    assert.equal(equal.find(result => result.status === 'rejected').reason, 0xA);
});

test('failed world migration rolls back the route fence and every subscription change', async t => {
    const f = fixture(t);
    f.addSubscription(f.worldRoute, { id: 'a', kind: 'presence' });
    f.addSubscription(f.worldRoute, { id: 'b', kind: 'friends' });
    const before = clone(f.state.tables), update = f.models.SocialSubscription.update;
    let calls = 0;
    f.models.SocialSubscription.update = async (...args) => {
        if (++calls === 2) { throw new Error('Injected migration failure'); }
        return update(...args);
    };
    await assert.rejects(f.runtime.refreshWorldRoute({ ...f.state.world, routeEpoch: '2' }, 'queue-new'), /migration failure/);
    assert.deepEqual(f.state.tables, before);
    f.state.process = null;
    await assert.rejects(f.runtime.refreshWorldRoute({ ...f.state.world, routeEpoch: '2' }, 'queue-new'), value => value === 0xA);
    assert.deepEqual(f.state.tables, before);
});

test('world route cleanup retains zero-subscription fences through account changes and dependency outages', async t => {
    const f = fixture(t), lookup = f.models.RealmProcessOwner.findByPk;
    f.state.account.isBanned = true;
    await f.runtime.cleanupWorldRoutes();
    assert.equal(f.state.tables.SocialWorldRoute.size, 1);
    f.models.RealmProcessOwner.findByPk = async () => { throw new Error('SQL unavailable'); };
    await assert.rejects(f.runtime.cleanupWorldRoutes(), /SQL unavailable/);
    assert.equal(f.state.tables.SocialWorldRoute.size, 1);
    f.models.RealmProcessOwner.findByPk = lookup;
    f.state.redis.delete('/skymist/v1/sessions/' + G);
    await f.runtime.cleanupWorldRoutes();
    assert.equal(f.state.tables.SocialWorldRoute.size, 0);
    await assert.rejects(f.runtime.refreshWorldRoute(f.worldRoute.owner, 'world-queue'), value => value === 0xA);
});

test('world route migration and model keep unsigned epochs and an independent unique session fence', async t => {
    const { Sequelize, DataTypes } = require('sequelize');
    const sequelize = new Sequelize('unused', 'unused', '', { dialect: 'mysql', logging: false });
    t.after(() => sequelize.close());
    const { SocialWorldRoute: model } = require('../models/socialruntime')(sequelize, DataTypes);
    assert.equal(model.getTableName(), 'social_world_routes');
    assert.equal(model.rawAttributes.routeEpoch.type.toSql(), 'BIGINT UNSIGNED');
    assert.equal(model.rawAttributes.routeEpoch.field, 'route_epoch');
    const row = model.build({ id: 'route', sessionKey: 'w:session:1', accountId: A, gameAccountId: G, routeEpoch: OBJECT, route: {} });
    await row.validate(); assert.equal(row.routeEpoch, OBJECT);
    const migration = require('../migrations/20261112000007-social-world-routes'), queries = [];
    await migration.up({ sequelize: { query: async sql => queries.push(sql) } });
    assert.match(queries[0], /UNIQUE KEY social_world_route_session \(session_key\)/);
    assert.match(queries[0], /route_epoch BIGINT UNSIGNED/);
    assert.match(queries[1], /\(account_id, blocked_account_id\)/);
    await assert.rejects(migration.down(), /authenticated session cleanup/);
});

test('notification channel error or close requests one fatal shutdown across both broker connections', async t => {
    for (const side of ['connection', 'world']) {
        for (const event of ['error', 'close']) {
            const failures = [], f = fixture(t, { onChannelFailure: error => { failures.push(error); } });
            const channels = { connection: f.runtime.channel, world: f.runtime.realmChannel };
            f.runtime.schedule = () => {};
            f.runtime.amqpConnection = { createConfirmChannel: async () => channels.connection };
            await f.runtime.start({ createConfirmChannel: async () => channels.world });
            const cause = new Error('Closed publisher');
            channels[side].emit(event, event === 'error' ? cause : undefined);
            assert.equal(f.runtime.channelFailed, true);
            channels.connection.emit('close'); channels.world.emit('error', new Error('Follow-up'));
            await Promise.resolve();
            assert.equal(failures.length, 1); assert.ok(failures[0] instanceof Error);
            if (event === 'error') { assert.equal(failures[0], cause); }
            await assert.rejects(f.runtime.notify(f.addSubscription(), [frame('blocked')]), /channel unavailable/);
            await f.runtime.stop();
        }
    }
});

test('intentional runtime shutdown suppresses channel callbacks and shared broker channels are watched once', async t => {
    const failures = [], f = fixture(t, { onChannelFailure: error => failures.push(error) });
    const channel = f.runtime.channel;
    f.runtime.schedule = () => {};
    f.runtime.amqpConnection = { createConfirmChannel: async () => channel };
    let closed = 0;
    channel.close = async () => { closed++; channel.emit('close'); channel.emit('error', new Error('Closing')); };
    await f.runtime.start();
    assert.equal(channel.listenerCount('close'), 1); assert.equal(channel.listenerCount('error'), 1);
    const first = f.runtime.stop();
    assert.equal(f.runtime.stop(), first);
    await first;
    await Promise.resolve();
    assert.equal(closed, 1); assert.deepEqual(failures, []);
});

test('runtime closes both notification channels once even when one close rejects', async t => {
    const f = fixture(t), failure = new Error('Channel already closed'), closed = [];
    f.runtime.channel.close = async () => { closed.push('connection'); throw failure; };
    f.runtime.realmChannel.close = async () => { closed.push('world'); };
    const first = f.runtime.stop();
    assert.equal(f.runtime.stop(), first);
    await assert.rejects(first, error => error === failure);
    assert.deepEqual(closed.sort(), ['connection', 'world']);
});

test('stale world generation cleanup removes only the retired fence and subscriptions on pulse', async t => {
    const f = fixture(t);
    f.addSubscription(f.worldRoute, { id: 'old-subscription' });
    const next = { ...f.state.world, generation: '9007199254741012' };
    f.state.redis.set('/skymist/v1/sessions/' + G, JSON.stringify(next));
    const nextOwner = { ...next, routeEpoch: '2' };
    await f.runtime.refreshWorldRoute(nextOwner, 'next-queue');
    const context = {};
    f.runtime.worldContext(context, nextOwner, 'next-queue');
    f.runtime.register('test', { snapshot: async () => ({ value: 'current' }), diff: () => [] });
    const row = await f.runtime.subscribe(context, await f.runtime.session(context), 'test', A, OBJECT);
    await context.afterReply();
    await f.runtime.pulse();
    assert.equal(f.state.tables.SocialWorldRoute.size, 1);
    assert.equal([...f.state.tables.SocialWorldRoute.values()][0].route.owner.generation, next.generation);
    assert.equal(f.state.tables.SocialSubscription.has('old-subscription'), false);
    assert.equal(f.state.tables.SocialSubscription.has(row.id), true);
    await assert.rejects(f.runtime.refreshWorldRoute(f.worldRoute.owner, 'world-queue'), value => value === 0xA);
});

test('inactive world presence keeps its route fence while the selected license lease remains live', async t => {
    const f = fixture(t), owner = { ...f.state.world, routeEpoch: '2' };
    // Presence withdrawal or its TTL cannot retire the independently owned world session.
    f.state.redis.set('/skymist/v1/social/character/' + G, JSON.stringify({ owner, sequence: '7', character: null }));
    await f.runtime.refreshWorldRoute(owner, 'queue-inactive');
    await f.runtime.pulse();
    f.state.redis.delete('/skymist/v1/social/character/' + G);
    await f.runtime.pulse();
    assert.equal(f.state.tables.SocialWorldRoute.size, 1);
    assert.equal((await f.runtime.refreshWorldRoute(owner, 'queue-inactive')).changed, false);
    assert.equal([...f.state.tables.SocialWorldRoute.values()][0].routeEpoch, '2');
    f.state.process = { ...f.state.process, instance_id: '5e55e55e-0000-4000-8000-0000000000ff' };
    await f.runtime.pulse();
    assert.equal(f.state.tables.SocialWorldRoute.size, 0);
    await assert.rejects(f.runtime.refreshWorldRoute(owner, 'queue-inactive'), value => value === 0xA);
});

test('refresh waits for an in-flight subscription diff and cannot overwrite its confirmed snapshot', async t => {
    const f = fixture(t), row = f.addSubscription(f.worldRoute, { kind: 'friends' });
    let entered, release;
    const projecting = new Promise(resolve => { entered = resolve; });
    const paused = new Promise(resolve => { release = resolve; });
    f.runtime.register('friends', { snapshot: async () => { entered(); await paused; return { value: 'new' }; }, diff: () => [frame('new')] });
    const diff = f.runtime.reconcileRow(row.id);
    await projecting;
    const refresh = f.runtime.refreshWorldRoute({ ...f.state.world, routeEpoch: '2' }, 'queue-new');
    release(); await Promise.all([diff, refresh]);
    const updated = f.state.tables.SocialSubscription.get(row.id);
    assert.equal(updated.route.queueName, 'queue-new'); assert.equal(updated.route.owner.routeEpoch, '2');
    assert.deepEqual(updated.snapshot, { value: 'new' }); assert.equal(updated.ready, true);
    assert.equal(f.state.sent.length, 1); assert.equal(f.state.sent[0].queue, 'world-queue');
    await f.runtime.reconcileRow(row.id);
    assert.equal(f.state.sent.length, 1);
});

test('each reconciliation pulse runs every registered projector cleanup with a bounded batch', async t => {
    const f = fixture(t), cleaned = [];
    f.runtime.register('legacy', { snapshot: async () => ({}), diff: () => [], cleanup: async limit => cleaned.push(limit) });
    f.runtime.register('friends', { snapshot: async () => ({}), diff: () => [] });
    await f.runtime.pulse();
    assert.deepEqual(cleaned, [20]);
});

test('a social session carries its request; sessions rebuilt for stored subscriptions cannot act for an RPC', async t => {
    const f = fixture(t), live = await f.owner();
    assert.ok(live instanceof SocialSession);
    assert.equal(live.sessionKey, 'c:first');
    assert.equal(JSON.stringify(live).includes('runtime'), false);
    const stored = await f.runtime.current(f.connectionRoute, A);
    assert.ok(stored instanceof SocialSession);
    assert.equal(stored.sessionKey, live.sessionKey);
    assert.throws(() => stored.operationId(), value => value === 0xA);
    await assert.rejects(stored.subscribe('test', A, OBJECT), value => value === 0xA);
    await assert.rejects(live.selectedGame(), value => value === 0xA);
    assert.equal((await live.selectGame(G)).gameAccountId, G);
    assert.equal((await live.selectedGame()).id, G);
    await assert.rejects(live.selectGame(G2), value => value === 0xA);
});
