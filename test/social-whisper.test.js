'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const Long = require('long');
const { WatchError } = require('redis');
const NotificationService = require('../services/notification');
const { watched } = require('../utils/redis-transaction');
const wire = require('../social/wire');
const { SocialError } = require('../social/errors');
const { fixture } = require('./support/social-graph-fixture');

const A = '9007199254740993', B = '9007199254740995', C = '9223372036854775807';
const GAME = '9007199254741001', OTHER_GAME = '9007199254741003', FOREIGN_GAME = '9007199254741005';
const GAME_HIGH = Long.fromBits(0x576F57, 0x02000001, true);
const SYSTEM = { high: '144115188075855872', low: '0' };
const Header = wire.type('rpc_types', 'bgs.protocol.Header');
const Notification = wire.type('notification_service', 'bgs.protocol.notification.v1.Notification');
const entity = low => ({ high: GAME_HIGH, low: Long.fromString(low, true) });
const message = (text = 'hello') => ({ type: 'WHISPER', targetId: SYSTEM, senderId: entity(GAME),
    senderAccountId: wire.account(A), targetAccountId: wire.account(B), attribute: [wire.textAttribute('whisper', text)] });

// Exercise the production WATCH/EXEC loop with independent transaction clients
// sharing a deterministic primary. No Redis, SQL, timers or broker processes.
function redis() {
    const state = { now: 1700000000000, rows: new Map(), versions: new Map(), writes: [], transactions: [],
        watchCount: 0, conflicts: 0, abortOnce: false, uncertain: false, unavailable: false };
    const version = key => {
        if (state.rows.get(key)?.expiresAt <= state.now) {
            state.rows.delete(key); state.versions.set(key, (state.versions.get(key) || 0) + 1);
        }
        return state.versions.get(key) || 0;
    };
    state.transaction = async (keys, decide) => {
        state.transactions.push(keys);
        if (state.unavailable) { throw new Error('Redis unavailable'); }
        let observed;
        const client = {
            watch: async keys => { state.watchCount++; observed = keys.map(key => [key, version(key)]); },
            unwatch: async () => {},
            get: async key => { version(key); return state.rows.get(key)?.value ?? null; },
            sendCommand: async command => {
                assert.deepEqual(command, ['TIME']);
                return [String(Math.floor(state.now / 1000)), String((state.now % 1000) * 1000)];
            },
            multi: () => {
                const commands = [];
                return {
                    sendCommand: command => commands.push(command), ping() {},
                    exec: async () => {
                        if (state.abortOnce || observed.some(([key, old]) => version(key) !== old)) {
                            state.abortOnce = false; state.conflicts++; throw new WatchError();
                        }
                        for (const command of commands) {
                            const [op, key, value, ttl, duration] = command;
                            assert.equal(op, 'SET'); assert.equal(ttl, 'PX');
                            state.rows.set(key, { value, expiresAt: state.now + Number(duration) });
                            state.versions.set(key, version(key) + 1); state.writes.push(command);
                        }
                        if (state.uncertain) { throw new Error('Uncertain Redis EXEC'); }
                    }
                };
            }
        };
        return watched(client, keys, decide);
    };
    return state;
}

function setup(store = redis()) {
    const owner = { accountId: A, gameAccountId: GAME, applicationVersion: 26972, sessionKey: 'c:sender' };
    const games = new Map([[GAME, A], [OTHER_GAME, A], [FOREIGN_GAME, B]].map(([id, accountId]) =>
        [id, { id, accountId, entityId: entity(id), program: 'WoW', region: 1 }]));
    const profile = { battleTag: 'Sender#1234', givenName: 'Private', surname: 'Name', realIdEnabled: true };
    const attempts = [], deliveries = [], access = [], blocks = [], errors = [];
    const blocked = new Set(), live = new Map();
    const state = { rows: [], notify: null };
    const models = { GameAccount: { findByPk: async id => games.get(id) || null }, Account: { findByPk: async () => profile } };
    const runtime = {
        store, owner: async context => { if (context.unauthenticated) { throw 0xA; } return owner; },
        graph: { assertAccess: async (...args) => access.push(args) },
        sessionBlocked: async (sessionKey, parent) => { blocks.push([sessionKey, parent]); return blocked.has(sessionKey + ':' + parent); },
        recipients: async (parent, kind) => { assert.equal(parent, B); assert.equal(kind, 'friends'); return state.rows; },
        current: async (route, parent) => {
            const peer = live.get(route.type === 'connection' ? 'c:' + route.connectionId : 'w:' + route.owner.session_id + ':' + route.owner.generation);
            return peer?.accountId === parent ? peer : null;
        },
        notify: async (row, frames) => {
            attempts.push({ row, frames });
            if (state.notify) { return state.notify(row, frames); }
            const route = typeof row.route === 'string' ? JSON.parse(row.route) : row.route;
            if (!await runtime.current(route, String(row.accountId))) { return false; }
            deliveries.push({ row, frames }); return true;
        }
    };
    function recipient(connectionId, options = {}) {
        const route = options.world ? { type: 'world', queueName: 'world-q', owner: { account_id: B,
            game_account_id: FOREIGN_GAME, session_id: connectionId, generation: '9007199254741011' } } :
            { type: 'connection', connectionId, queueName: 'q:' + connectionId, address: '127.0.0.1' };
        const sessionKey = options.world ? 'w:' + connectionId + ':' + route.owner.generation : 'c:' + connectionId;
        live.set(sessionKey, { accountId: B, sessionKey, route });
        const row = { id: String(state.rows.length), accountId: B, sessionKey, objectId: options.objectId || '18446744073709551615',
            route: options.json ? JSON.stringify(route) : route };
        state.rows.push(row); return row;
    }
    recipient('receiver');
    const service = new NotificationService({ models, runtime, logger: { error: error => errors.push(error) } });
    return { owner, games, profile, models, runtime, service, store, state, attempts, deliveries, access, blocks, blocked, live, errors, recipient };
}

async function rpc(f, request = message(), extras = {}) {
    const payload = Notification.encode(Notification.fromObject(request)).finish();
    const context = { header: { serviceId: 0, serviceHash: f.service.getServiceHash(), methodId: 1, token: 23,
        objectId: Long.fromString('18446744073709551615', true) }, ...extras };
    const response = await f.service.handleCall(context, payload);
    const size = response.readUInt16BE(0);
    const header = Header.decode(response.subarray(2, 2 + size));
    assert.equal(header.token, 23);
    assert.equal(header.objectId.toString(), '18446744073709551615');
    assert.equal(response.length, 2 + size); // NoData, including errors.
    return header.status;
}

test('26972 NotificationSend and global listener preserve full entities and emit only server-owned BattleTag metadata', async () => {
    const f = setup();
    assert.equal(wire.hash(f.service.rootNamespace.lookupService('NotificationService').fullName.slice(1)), 0x53C8C253);
    assert.equal(await rpc(f, { ...message(), senderBattleTag: 'Forged#9999', targetBattleTag: 'Injected#9999',
        forwardingIdentity: { accountId: wire.account(C) }, peer: { label: 7, epoch: 8 } }), 0);
    assert.equal(f.deliveries.length, 1);
    const frame = f.deliveries[0].frames[0], value = Notification.decode(frame.payload);
    assert.equal(frame.objectId, '0'); assert.equal(frame.methodId, 1);
    assert.equal(frame.serviceHash, wire.hash('bnet.protocol.notification.NotificationListener'));
    assert.equal(frame.worldHash, wire.hash('bgs.protocol.notification.v1.NotificationListener'));
    assert.equal(value.type, 'WHISPER');
    assert.equal(value.targetId.high.toString(), SYSTEM.high); assert.equal(value.targetId.low.toString(), '0');
    assert.equal(value.senderId.low.toString(), GAME); assert.equal(value.senderId.high.toString(), GAME_HIGH.toString());
    assert.equal(value.senderAccountId.low.toString(), A); assert.equal(value.targetAccountId.low.toString(), B);
    assert.equal(value.senderBattleTag, 'Sender#1234');
    assert.deepEqual(Object.keys(value.attribute[0].value), ['stringValue']);
    assert.equal(value.attribute[0].name, 'whisper'); assert.equal(value.attribute[0].value.stringValue, 'hello');
    for (const name of ['targetBattleTag', 'forwardingIdentity', 'peer']) { assert.equal(Object.hasOwn(value, name), false); }
    assert.equal(JSON.stringify(value).includes('Private'), false);
    assert.deepEqual(f.access, [[A, B, 'whisper']]);
    assert.deepEqual(f.blocks, [['c:sender', B], ['c:receiver', A]]);
});

test('authentication and bound selection are required, including when sender fields are omitted', async () => {
    const f = setup();
    assert.equal(await rpc(f, message(), { unauthenticated: true }), 0xA);
    delete f.owner.gameAccountId;
    assert.equal(await rpc(f), 0xA);
    const request = message(); delete request.senderId; delete request.senderAccountId;
    assert.equal(await rpc(f, request), 0xA);
    f.owner.gameAccountId = GAME;
    assert.equal(await rpc(f, request), 0);
    assert.equal(Notification.decode(f.deliveries[0].frames[0].payload).senderId.low.toString(), GAME);
    assert.equal(f.store.transactions.length, 1);
});

test('forged parents, foreign licenses, wrong entity high bits and another owned license cannot send', async () => {
    for (const fields of [{ senderAccountId: wire.account(C) }, { senderId: entity(FOREIGN_GAME) },
        { senderId: entity(OTHER_GAME) }, { senderId: { high: SYSTEM.high, low: GAME } },
        { senderId: { high: GAME_HIGH.add(Long.fromInt(1)), low: GAME } }]) {
        const f = setup();
        assert.equal(await rpc(f, { ...message(), ...fields }), 0xA);
        assert.equal(f.attempts.length, 0); assert.equal(f.store.transactions.length, 0);
    }
    for (const change of [game => { game.accountId = C; }, game => { game.isSuspended = true; }, game => { game.isBanned = true; }]) {
        const f = setup(); change(f.games.get(GAME));
        assert.equal(await rpc(f), 0xA); assert.equal(f.attempts.length, 0);
    }
});

test('wrong system destinations, types, parent kinds, zero and unsigned-overflow parent IDs reject', async () => {
    for (const fields of [{ type: 'whisper' }, { type: 'WHISPER\0' }, { targetId: { high: SYSTEM.high, low: '1' } },
        { targetId: wire.account(B) }, { targetAccountId: entity(FOREIGN_GAME) }, { targetAccountId: { high: wire.ACCOUNT_HIGH, low: '0' } },
        { targetAccountId: { high: wire.ACCOUNT_HIGH, low: '9223372036854775808' } }, { targetAccountId: null }]) {
        const f = setup();
        assert.equal(await rpc(f, { ...message(), ...fields }), fields.type ? 0x6595 : 0xBC5);
        assert.equal(f.attempts.length, 0); assert.equal(f.store.transactions.length, 0);
    }
});

test('exactly one whisper attribute and one explicit string Variant are accepted', async () => {
    const variants = [{}, { intValue: '1' }, { stringValue: '', boolValue: false },
        ...[{ boolValue: false }, { intValue: '0' }, { floatValue: 0 }, { blobValue: Buffer.alloc(0) },
            { messageValue: Buffer.alloc(0) }, { fourccValue: '' }, { uintValue: '0' }, { entityIdValue: wire.account(A) }]
            .map(other => ({ stringValue: 'hello', ...other }))];
    const attributes = [[], [wire.textAttribute('other', 'hello')], [wire.textAttribute('whisper', 'hello'), wire.textAttribute('whisper', 'hello')],
        ...variants.map(value => [{ name: 'whisper', value }])];
    for (const attribute of attributes) {
        const f = setup();
        assert.equal(await rpc(f, { ...message(), attribute }), 0xBC5);
        assert.equal(f.attempts.length, 0); assert.equal(f.store.transactions.length, 0);
    }
});

test('whispers enforce a 1020 UTF-8 byte ceiling, preserve Unicode and reject NUL, empty and ill-formed strings', async () => {
    for (const text of ['a'.repeat(1020), '😀'.repeat(255), '€'.repeat(340)]) {
        const f = setup(); assert.equal(await rpc(f, message(text)), 0);
        assert.equal(Notification.decode(f.deliveries[0].frames[0].payload).attribute[0].value.stringValue, text);
    }
    for (const text of ['a'.repeat(1021), '😀'.repeat(256)]) { assert.equal(await rpc(setup(), message(text)), 0x1B59); }
    for (const text of ['', 'a\0b']) { assert.equal(await rpc(setup(), message(text)), 0xBC5); }
    // JS's protobuf encoder normalizes lone surrogates before decoding; exercise
    // the handler separately to cover invalid in-process semantic input too.
    for (const text of ['\uD800', 42]) {
        const f = setup(); await assert.rejects(f.service.send({ request: message(text) }), error => error === 0xBC5);
        assert.equal(f.attempts.length, 0);
    }
});

test('accepted friendship is required and either parent durable block prevents delivery', async t => {
    const graph = fixture(); t.after(() => graph.sequelize.close());
    for (const id of [A, B]) { await graph.Account.create({ id, battleTag: 'Player#1234' }); }
    const f = setup(); f.runtime.graph = graph.graph;
    assert.equal(await rpc(f), 0x1B58);
    const { invitationId } = await graph.graph.invite({ actorId: A, targetId: B, kind: 'battle_tag', operationId: 'invite' });
    assert.equal(await rpc(f), 0x1B58);
    await graph.graph.accept({ actorId: B, targetId: A, invitationId, operationId: 'accept' });
    assert.equal(await rpc(f), 0);
    await graph.graph.block({ actorId: A, targetId: B, operationId: 'block-a' });
    assert.equal(await rpc(f), 0x1B58);
    await graph.graph.unblock({ actorId: A, targetId: B, operationId: 'unblock-a' });
    await graph.graph.block({ actorId: B, targetId: A, operationId: 'block-b' });
    assert.equal(await rpc(f), 0x1B58);
    assert.equal(f.deliveries.length, 1);
});

test('sender session blocks deny, recipient session blocks filter only that connection or world session', async () => {
    const f = setup(); f.recipient('other'); f.recipient('world', { world: true });
    f.blocked.add('c:sender:' + B);
    assert.equal(await rpc(f), 0x1B58); assert.equal(f.attempts.length, 0);
    f.blocked.clear(); f.blocked.add('c:receiver:' + A); f.blocked.add('w:world:9007199254741011:' + A);
    assert.equal(await rpc(f), 0);
    assert.deepEqual(f.deliveries.map(value => value.row.sessionKey), ['c:other']);
    f.blocked.add('c:other:' + A);
    assert.equal(await rpc(f), 0x1B58); assert.equal(f.attempts.length, 1);
    f.blocked.delete('c:receiver:' + A);
    assert.equal(await rpc(f), 0); assert.equal(f.deliveries.at(-1).row.sessionKey, 'c:receiver');
});

test('duplicate Friends objects fan out once per current route, retaining independent connection and world recipients', async () => {
    const f = setup();
    f.recipient('receiver', { json: true, objectId: '2' });
    f.recipient('other', { objectId: '2' });
    f.recipient('world', { world: true, objectId: '3' }); f.recipient('world', { world: true, json: true, objectId: '4' });
    f.recipient('stale'); f.live.delete('c:stale');
    f.state.rows.push({ ...f.state.rows[0], accountId: C });
    assert.equal(await rpc(f), 0);
    assert.deepEqual(f.deliveries.map(value => value.row.sessionKey), ['c:receiver', 'c:other', 'w:world:9007199254741011']);
    assert.ok(f.deliveries.every(value => value.frames.length === 1 && value.frames[0].objectId === '0'));
});

test('offline targets and expired routes are undeliverable, never queued for a later subscription', async () => {
    for (const expire of [f => { f.state.rows = []; }, f => f.live.clear(),
        f => { f.state.notify = async () => false; }]) {
        const f = setup(); expire(f);
        assert.equal(await rpc(f, message('never replay me')), 0x1B58);
        assert.equal(f.deliveries.length, 0);
        f.state.notify = null; f.live.clear(); f.recipient('reconnected');
        assert.equal(await rpc(f, message('new live text')), 0);
        assert.deepEqual(f.deliveries.map(value => Notification.decode(value.frames[0].payload).attribute[0].value.stringValue), ['new live text']);
        assert.equal(JSON.stringify(f.store.writes).includes('replay'), false);
    }
});

test('10 sends per rolling 10 seconds are shared by workers, licenses, routes and targets of an authenticated parent', async () => {
    const store = redis(), first = setup(store), second = setup(store);
    second.owner.gameAccountId = OTHER_GAME; second.owner.sessionKey = 'w:second:4';
    for (let index = 0; index < 10; index++) {
        const f = index % 2 ? second : first;
        assert.equal(await rpc(f, { ...message(), senderId: entity(f.owner.gameAccountId) }), 0);
        store.now += 500;
    }
    assert.equal(await rpc(first), 0xBBA);
    assert.equal(await rpc(first, { ...message(), targetAccountId: wire.account(C) }), 0xBBA);
    assert.equal(first.attempts.length + second.attempts.length, 10);
    assert.equal(store.rows.size, 1);
    const key = [...store.rows.keys()][0]; assert.ok(key.endsWith('/' + A));
    assert.ok(store.transactions.every(keys => keys.length === 1 && keys[0] === key));
    assert.ok(store.writes.every(command => command[4] === '10000'));
    store.now = 1700000009999; assert.equal(await rpc(first), 0xBBA);
    store.now++; assert.equal(await rpc(first), 0);
    assert.equal(await rpc(first), 0xBBA); // Rolling window, not a reset-at-boundary burst.
    const other = setup(store); other.owner.accountId = C; other.games.get(GAME).accountId = C;
    assert.equal(await rpc(other, { ...message(), senderAccountId: wire.account(C) }), 0);
    assert.equal(store.rows.size, 2);
    store.now += 10000; assert.equal(await rpc(first), 0);
    assert.deepEqual(JSON.parse(store.rows.get(key).value), [store.now]);
});

test('simultaneous workers cannot take the same last rate slot and CAS retries cannot duplicate fanout', async () => {
    const store = redis(), first = setup(store), second = setup(store);
    store.abortOnce = true;
    for (let index = 0; index < 9; index++) { assert.equal(await rpc(first), 0); }
    const statuses = await Promise.all([rpc(first), rpc(second)]);
    assert.deepEqual(statuses.sort((a, b) => a - b), [0, 0xBBA]);
    assert.equal(first.attempts.length + second.attempts.length, 10);
    assert.equal(store.writes.length, 10); assert.ok(store.conflicts >= 2);
});

test('an uncertain Redis transaction is not retried or followed by delivery; metadata contains no text', async () => {
    const f = setup(); f.store.uncertain = true;
    assert.equal(await rpc(f, message('private-whisper-content')), 1);
    assert.equal(f.store.watchCount, 1); assert.equal(f.store.writes.length, 1);
    assert.equal(f.attempts.length, 0);
    assert.equal(JSON.stringify(f.store.writes).includes('private-whisper-content'), false);
    assert.deepEqual(JSON.parse(f.store.writes[0][2]), [f.store.now]);
});

test('dependency and session-policy outages fail closed and never become successful synchronous sends', async () => {
    const fail = async () => { throw new Error('Dependency unavailable'); };
    for (const outage of [f => { f.store.unavailable = true; }, f => { f.runtime.graph.assertAccess = fail; },
        f => { f.runtime.recipients = fail; }, f => { f.runtime.current = fail; }, f => { f.runtime.sessionBlocked = fail; },
        f => { delete f.runtime.sessionBlocked; }, f => { f.models.Account.findByPk = fail; }]) {
        const f = setup(); outage(f);
        assert.equal(await rpc(f), 1); assert.equal(f.attempts.length, 0);
    }
    const f = setup(); f.runtime.graph.assertAccess = async () => { throw new SocialError('BLOCKED'); };
    assert.equal(await rpc(f), 0x1B58); assert.equal(f.attempts.length, 0);
});

test('partial or uncertain publisher failure stops fanout without retry, history or background recovery', async () => {
    const f = setup(); f.recipient('second'); f.recipient('third');
    f.state.notify = async (row, frames) => {
        f.deliveries.push({ row, frames }); // Broker may have accepted before confirmation was lost.
        if (row.sessionKey === 'c:second') { throw new Error('Confirmation lost'); }
        return true;
    };
    assert.equal(await rpc(f, message('uncertain')), 1);
    assert.deepEqual(f.attempts.map(value => value.row.sessionKey), ['c:receiver', 'c:second']);
    f.state.notify = null;
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(f.attempts.length, 2);
    assert.equal(await rpc(f, message('next')), 0);
    assert.deepEqual(f.deliveries.map(value => Notification.decode(value.frames[0].payload).attribute[0].value.stringValue),
        ['uncertain', 'uncertain', 'next', 'next', 'next']);
    assert.equal(JSON.stringify(f.store.writes).includes('uncertain'), false);
});
