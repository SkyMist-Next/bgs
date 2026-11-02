'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { RedisStore, configuration, METADATA } = require('../utils/redis-store');

function setup(options = {}) {
    const client = new EventEmitter();
    Object.assign(client, { isReady: true, getMasterNode: () => ({ host: 'primary' }), withCommandOptions: () => client,
        ping: async () => 'PONG', close: async () => {}, destroy: async () => {} });
    return { client, store: new RedisStore({ client, ...options }) };
}

test('Sentinel configuration validates endpoints and separates credentials', () => {
    const env = { REDIS_SENTINELS: '[{"host":"seed","port":26379}]', REDIS_MASTER_NAME: 'bgs',
        REDIS_PASSWORD: 'data-secret', REDIS_SENTINEL_PASSWORD: 'sentinel-secret' };
    const options = configuration(env);
    assert.equal(options.nodeClientOptions.password, 'data-secret');
    assert.equal(options.sentinelClientOptions.password, 'sentinel-secret');
    assert.equal(options.replicaPoolSize, 0);
    assert.equal(options.maxCommandRediscovers, 0);
    assert.equal(options.nodeClientOptions.disableOfflineQueue, true);
    assert.equal(options.nodeClientOptions.commandsQueueMaxLength, 1024);
    for (const changes of [{ REDIS_SENTINELS: undefined }, { REDIS_SENTINELS: '[]' },
        { REDIS_SENTINELS: '[{"host":"seed","port":0}]' }, { REDIS_MASTER_NAME: '' },
        { REDIS_DB: '-1' }, { REDIS_DB: '1.5' }, { REDIS_TLS: 'yes' }]) {
        assert.throws(() => configuration({ ...env, ...changes }));
    }
});

test('metadata scanning is deterministic, deduplicated, literal-prefix based, and separate from ticket keys', async () => {
    const { client, store } = setup();
    const cursors = [];
    client.hScan = async (key, cursor) => {
        assert.equal(key, METADATA);
        cursors.push(cursor);
        return cursor === '0' ? { cursor: '7', entries: [
            { field: '/p/b', value: '2' }, { field: '/other', value: '9' }
        ] } : { cursor: '0', entries: [{ field: '/p/a', value: '1' }, { field: '/p/b', value: '2' }] };
    };
    assert.deepEqual(await store.listMetadata('/p/'), { '/p/a': '1', '/p/b': '2' });
    assert.deepEqual(cursors, ['0', '7']);
    assert.deepEqual(await store.listMetadata('/p/*'), {});
});

test('scan interruption and record/byte limits never return partial metadata', async () => {
    for (const options of [{ maxRecords: 1 }, { maxBytes: 1 }, {}]) {
        const { client, store } = setup(options);
        client.hScan = async () => {
            if (!Object.keys(options).length) { client.emit('reconnecting'); }
            return { cursor: '0', entries: [{ field: 'a', value: '1' }, { field: 'b', value: '2' }] };
        };
        await assert.rejects(store.listMetadata(''), /limit|interrupted/);
    }
});

test('JSON reads reject missing and malformed records; tickets retain string IDs', async () => {
    const { client, store } = setup();
    for (const value of [null, '{']) {
        client.get = client.hGet = async () => value;
        await assert.rejects(store.getJSON('ticket'));
        await assert.rejects(store.getMetadataJSON('realm'));
    }
    client.hGetAll = async () => ({ ticket: 'abc', program: 'WoW', accountId: '9007199254740993' });
    assert.equal((await store.getLoginTicket('abc')).accountId, '9007199254740993');
    client.hGetAll = async () => ({});
    assert.equal(await store.getLoginTicket('abc'), null);
});

test('timeouts abort late submissions and keep unsettled operations bounded', async () => {
    const { client, store } = setup({ operationTimeout: 10 });
    let signal;
    let release;
    client.withCommandOptions = options => { signal = options.abortSignal; return client; };
    client.ping = () => new Promise(resolve => { release = resolve; });
    await assert.rejects(store.ping(), /timed out/);
    assert.equal(signal.aborted, true);
    assert.equal(store.pending, 1);
    store.pending = 1024;
    await assert.rejects(store.ping(), /limit/);
    store.pending = 1;
    release('PONG');
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(store.pending, 0);
    client.isReady = false;
    await assert.rejects(store.ping(), /unavailable/);
});

test('closed stores reject new work and cancel health monitoring', async () => {
    const { store } = setup();
    store.monitor();
    await store.close();
    await assert.rejects(store.ping(), /unavailable/);
    assert.equal(store.healthy, false);
});

test('startup failure is bounded even when client connect never settles', async () => {
    const { client, store } = setup({ recoveryTimeout: 10 });
    let destroyed = false;
    client.connect = () => new Promise(() => {});
    client.destroy = async () => { destroyed = true; };
    await assert.rejects(store.connect(), /unavailable during startup/);
    assert.equal(destroyed, true);
    assert.equal(store.healthy, false);
});


test('primary probes remain coalesced after the caller times out', async () => {
    const { client, store } = setup({ operationTimeout: 5 });
    let release;
    let calls = 0;
    client.ping = () => { calls++; return new Promise(resolve => { release = resolve; }); };
    const first = store.probe();
    assert.equal(store.probe(), first);
    await assert.rejects(first, /timed out/);
    await assert.rejects(store.probe(), /timed out/);
    assert.equal(calls, 1);
    release('PONG');
    await new Promise(resolve => setImmediate(resolve));
    client.ping = async () => 'PONG';
    assert.equal(await store.probe(), 'PONG');
    await store.destroy();
});

test('a Redis connection completing after shutdown is destroyed and cannot start monitoring', async () => {
    const { client, store } = setup({ recoveryTimeout: 20 });
    let open;
    let destroyed = 0;
    client.connect = () => new Promise(resolve => { open = resolve; });
    client.destroy = async () => { destroyed++; };
    const connecting = store.connect();
    const rejected = assert.rejects(connecting, /unavailable during startup/);
    await new Promise(resolve => setImmediate(resolve));
    await store.destroy();
    open();
    await rejected;
    assert.ok(destroyed >= 2);
    assert.equal(store.healthy, false);
    assert.equal(store.monitorTimer, undefined);
});
