'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { readiness, lifecycle } = require('../utils/lifecycle');

test('readiness probes real dependencies, coalesces requests, and rejects during shutdown', async () => {
    let calls = 0;
    let release;
    let started = true;
    const store = { healthy: true, ping: async () => { calls++; } };
    const check = readiness({ store, sequelize: { authenticate: () => new Promise(resolve => { release = resolve; }) },
        isStarted: () => started });
    const first = check();
    const second = check();
    assert.equal(calls, 1);
    release();
    assert.deepEqual(await Promise.all([first, second]), [true, true]);
    assert.equal(await check(), true);
    assert.equal(calls, 1);
    store.healthy = false;
    assert.equal(await check(), false);
    store.healthy = true;
    started = false;
    assert.equal(await check(), false);
});

test('shutdown stops admission before draining and closes once', async t => {
    const signals = ['SIGINT', 'SIGTERM', 'unhandledRejection'];
    const before = new Map(signals.map(signal => [signal, process.listeners(signal)]));
    t.after(() => signals.forEach(signal => process.listeners(signal).forEach(listener => {
        if (!before.get(signal).includes(listener)) { process.removeListener(signal, listener); }
    })));
    const calls = [];
    let release;
    const runtime = lifecycle({ logger: { error() {} },
        stop: () => { calls.push('stop'); return new Promise(resolve => { release = resolve; }); },
        close: async () => calls.push('close'), force: async () => calls.push('force'), exit: code => calls.push(code) });
    const first = runtime.shutdown();
    assert.equal(runtime.stopping, true);
    assert.deepEqual(calls, ['stop']);
    assert.equal(runtime.shutdown(), first);
    release();
    await first;
    assert.deepEqual(calls, ['stop', 'close', 'force', 0]);
});

test('stalled work triggers forced cleanup and a nonzero exit within the drain deadline', async t => {
    const signals = ['SIGINT', 'SIGTERM', 'unhandledRejection'];
    const before = new Map(signals.map(signal => [signal, process.listeners(signal)]));
    t.after(() => signals.forEach(signal => process.listeners(signal).forEach(listener => {
        if (!before.get(signal).includes(listener)) { process.removeListener(signal, listener); }
    })));
    let forced = false;
    let exitCode;
    const runtime = lifecycle({ logger: { error() {} }, drainTimeout: 10, forceTimeout: 10,
        stop: () => new Promise(() => {}), close: async () => assert.fail('drain did not complete'),
        force: async () => { forced = true; }, exit: code => { exitCode = code; } });
    await runtime.shutdown();
    assert.equal(forced, true);
    assert.equal(exitCode, 1);
});

test('readiness timeouts do not accumulate probes behind a stuck database', async () => {
    let calls = 0;
    let release;
    const check = readiness({ store: { healthy: true, ping: async () => {} }, probeTimeout: 10,
        sequelize: { authenticate: () => { calls++; return new Promise(resolve => { release = resolve; }); } },
        isStarted: () => true });
    assert.equal(await check(), false);
    assert.equal(await check(), false);
    assert.equal(calls, 1);
    release();
});
