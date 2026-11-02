'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { EventEmitter } = require('node:events');
const { setTimeout: delay } = require('node:timers/promises');
const BaseServer = require('../servers/base-server');
const { readiness } = require('../utils/dependency-probe');
const { fixture, deferred, tick } = require('./support/server-fixture');

test('constructors are inert; concurrent starts/stops share promises and instances own their dependencies', async () => {
    const a = fixture();
    const b = fixture();
    const first = new BaseServer(a.options);
    const second = new BaseServer(b.options);
    assert.equal(first.state, 'created');
    assert.deepEqual(a.events, []);
    assert.equal(a.process.eventNames().length, 0);
    assert.equal(first.start(), first.start());
    await Promise.all([first.start(), second.start()]);
    assert.equal(await first.isReady(), true);
    const stopping = first.stop();
    assert.equal(first.state, 'stopping');
    assert.equal(first.isAccepting(), false);
    assert.equal(first.stop(), stopping);
    assert.deepEqual(await stopping, { exitCode: 0, forced: false, errors: [] });
    assert.equal(first.state, 'stopped');
    assert.equal(second.state, 'running');
    assert.equal(a.process.eventNames().length, 0);
    await assert.rejects(first.start(), /cannot restart/);
    assert.deepEqual(a.events.filter(event => event.endsWith('.close')).sort(), ['amqp.close', 'redis.close', 'sql.close']);
    await second.stop();
});

test('stop before start remains inert and prevents restart', async () => {
    const state = fixture();
    const server = new BaseServer(state.options);
    await server.stop();
    await assert.rejects(server.start(), /cannot restart/);
    assert.deepEqual(state.events, []);
});

test('SQL authentication is default; synchronization is explicit and development-only', async () => {
    for (const [environment, syncOnStart, valid] of [['production', undefined, true], ['development', true, true],
        ['production', true, false], ['test', true, false], ['development', 'true', false]]) {
        const state = fixture({ environment, database: { syncOnStart } });
        const server = new BaseServer(state.options);
        if (valid) {
            await server.start();
            assert.equal(state.events.includes('sql.sync'), syncOnStart === true);
            assert.ok(state.events.includes('sql.authenticate'));
            await server.stop();
        }
        else {
            await assert.rejects(server.start(), /syncOnStart/);
            assert.deepEqual(state.events, []);
            assert.equal((await server.closed).exitCode, 1);
        }
    }
});

test('dependencies connect concurrently and partial failure closes every acquired resource', async () => {
    const state = fixture();
    const sql = deferred();
    const redis = deferred();
    state.models.sequelize.authenticate = () => { state.events.push('sql.begin'); return sql.promise; };
    state.store.connect = () => { state.events.push('redis.begin'); return redis.promise; };
    const server = new BaseServer(state.options);
    const starting = server.start();
    const failed = assert.rejects(starting, /SQL failed/);
    await tick();
    assert.ok(state.events.includes('sql.begin'));
    assert.ok(state.events.includes('redis.begin'));
    assert.ok(state.events.includes('amqp.create'));
    sql.reject(new Error('SQL failed'));
    redis.resolve();
    await failed;
    assert.equal(server.state, 'stopped');
    for (const name of ['sql.close', 'redis.close', 'amqp.close']) { assert.ok(state.events.includes(name)); }
});

test('late dependency factories retain ownership after forced shutdown and never start workload', async () => {
    for (const name of ['amqp', 'store', 'database']) {
        const state = fixture({ shutdownTimeout: 15, forceTimeout: 10 });
        const opening = deferred();
        state.options.factories[name] = () => opening.promise;
        const server = new BaseServer(state.options);
        let started = false;
        server.onStart = async () => { started = true; };
        const rejected = assert.rejects(server.start(), /stopping/);
        await tick();
        assert.equal((await server.stop()).forced, true);
        opening.resolve(name === 'amqp' ? state.amqp : name === 'store' ? state.store : state.models);
        await rejected;
        await tick();
        assert.equal(started, false);
        assert.ok(state.events.includes({ amqp: 'amqp.close', store: 'redis.close', database: 'sql.close' }[name]));
    }
});

test('startup deadline cancels initialization, force cleanup is bounded, and all cleanup is attempted', async () => {
    const state = fixture({ startupTimeout: 10, shutdownTimeout: 15, forceTimeout: 10 });
    state.store.connect = () => new Promise(() => {});
    state.store.close = () => { state.events.push('redis.close'); return new Promise(() => {}); };
    state.models.sequelize.close = async () => { state.events.push('sql.close'); throw new Error('close failed'); };
    state.options.factories.forceDatabase = () => new Promise(() => {});
    const server = new BaseServer(state.options);
    const began = Date.now();
    await assert.rejects(server.start(), /startup timed out/);
    const result = await server.closed;
    assert.equal(result.forced, true);
    assert.equal(result.exitCode, 1);
    assert.ok(Date.now() - began < 500);
    for (const event of ['redis.close', 'redis.destroy', 'sql.close', 'amqp.close', 'amqp.destroy']) {
        assert.ok(state.events.includes(event), event);
    }
    assert.equal(state.process.eventNames().length, 0);
});

test('cleanup failures do not skip other dependencies', async () => {
    const state = fixture();
    state.models.sequelize.close = async () => { throw new Error('SQL close failed'); };
    const server = new BaseServer(state.options);
    await server.start();
    server.onStopAccepting = () => { throw new Error('admission failed'); };
    server.onDrain = () => { throw new Error('drain failed'); };
    const result = await server.stop();
    assert.equal(result.exitCode, 1);
    assert.ok(state.events.includes('redis.close'));
    assert.ok(state.events.includes('amqp.close'));
    assert.equal(result.errors.length, 3);
});

test('owned signal handlers are removed; repeated signals share shutdown and rejection fails', async () => {
    for (const fatal of [false, true]) {
        const state = fixture();
        const external = () => {};
        state.process.on('SIGINT', external);
        const server = new BaseServer(state.options);
        await server.start();
        const drain = deferred();
        server.onDrain = () => drain.promise;
        state.process.emit(fatal ? 'unhandledRejection' : 'SIGTERM', new Error('secret URL'));
        state.process.emit('SIGINT');
        drain.resolve();
        assert.equal((await server.closed).exitCode, fatal ? 1 : 0);
        assert.deepEqual(state.process.listeners('SIGINT'), [external]);
        assert.deepEqual(state.process.listeners('SIGTERM'), []);
        assert.deepEqual(state.process.listeners('unhandledRejection'), []);
    }
});

test('readiness deadlines coalesce underlying probes even after rejection or timeout', async () => {
    const sql = deferred();
    let calls = 0;
    let running = true;
    const store = { healthy: true, ping: async () => { throw new Error('Redis unavailable'); } };
    const check = readiness({ store, sequelize: { authenticate: () => { calls++; return sql.promise; } },
        isStarted: () => running, probeTimeout: 5 });
    assert.deepEqual(await Promise.all([check(), check()]), [false, false]);
    assert.equal(await check(), false);
    assert.equal(calls, 1);
    sql.resolve();
    running = false;
    assert.equal(await check(), false);
});

test('SQL degradation rejects new work, recovers, and a stuck probe fails within recovery budget', async () => {
    const state = fixture({ monitorInterval: 5, probeTimeout: 5, probeCacheTime: 0, recoveryTimeout: 30 });
    const server = new BaseServer(state.options);
    await server.start();
    const authenticate = state.models.sequelize.authenticate;
    state.models.sequelize.authenticate = async () => { throw new Error('SQL down'); };
    assert.equal(await server.isReady(), false);
    assert.equal(server.isAccepting(), false);
    state.models.sequelize.authenticate = authenticate;
    await tick();
    assert.equal(await server.isReady(), true);
    let calls = 0;
    const stuck = deferred();
    state.models.sequelize.authenticate = () => { calls++; return stuck.promise; };
    await server.isReady();
    const result = await server.closed;
    assert.equal(result.exitCode, 1);
    assert.equal(calls, 1);
    stuck.resolve();
});

test('broker blocking disables admission immediately; recovery restores it; close and sustained blocking fail', async () => {
    for (const failure of ['close', 'blocked']) {
        const state = fixture({ monitorInterval: 5, probeCacheTime: 0, recoveryTimeout: 20 });
        const server = new BaseServer(state.options);
        await server.start();
        state.amqp.emit('blocked');
        assert.equal(server.isAccepting(), false);
        state.amqp.emit('unblocked');
        assert.equal(await server.isReady(), true);
        state.amqp.emit(failure);
        assert.equal((await server.closed).exitCode, 1);
    }
});

test('CLI waits for cleanup and only forces process exit when cleanup was forced', async () => {
    const { launch } = require('../servers/cli');
    for (const forced of [false, true]) {
        const processObject = new EventEmitter();
        let exited;
        processObject.exit = code => { exited = code; };
        const closed = deferred();
        const task = launch(() => ({ start: async () => {}, closed: closed.promise }), processObject);
        await delay(1);
        assert.equal(processObject.exitCode, undefined);
        closed.resolve({ exitCode: forced ? 1 : 0, forced, errors: [] });
        await task;
        assert.equal(processObject.exitCode, forced ? 1 : 0);
        assert.equal(exited, forced ? 1 : undefined);
    }
});


test('fatal rejection during an existing graceful stop retains the failure exit status', async () => {
    const state = fixture();
    const server = new BaseServer(state.options);
    await server.start();
    const drain = deferred();
    server.onDrain = () => drain.promise;
    const stopping = server.stop();
    state.process.emit('unhandledRejection', new Error('fatal'));
    drain.resolve();
    assert.equal((await stopping).exitCode, 1);
});
