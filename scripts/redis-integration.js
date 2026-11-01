'use strict';

// Opt-in, Linux Docker integration. Only uniquely named, harness-owned resources are removed.
const assert = require('node:assert/strict');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { once } = require('node:events');
const { setTimeout: delay } = require('node:timers/promises');
const { performance, monitorEventLoopDelay } = require('node:perf_hooks');
const { createClient } = require('redis');
const { RedisStore, LOGIN_PREFIX } = require('../utils/redis-store');
const createRestApp = require('../utils/rest-app');
const { readiness } = require('../utils/lifecycle');
const execute = promisify(execFile);
const docker = async (...args) => (await execute('docker', args, { timeout: 60000 })).stdout.trim();
const image = process.env.REDIS_TEST_IMAGE || 'redis@sha256:2838d5524559494f6f1cd66e97e76b200d64a633a8614200620755ed395daf32';
const prefix = `bgs-redis-test-${process.pid}-${Date.now()}`;
const containers = [];
const stores = [];
const clients = [];
const logger = { info() {}, error() {} };
let networkCreated = false;
let httpServer;

async function container(name, command) {
    const fullName = prefix + '-' + name;
    containers.push(fullName);
    await docker('run', '-d', '--name', fullName, '--network', prefix, image, ...command);
    const ip = await docker('inspect', '--format', '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}', fullName);
    return { name: fullName, ip };
}

async function eventually(check, milliseconds = 20000) {
    const deadline = Date.now() + milliseconds;
    let last;
    while (Date.now() < deadline) {
        try { return await check(); }
        catch (error) { last = error; await delay(100); }
    }
    throw last || new Error('Condition timed out');
}

async function measure(name, operation, count = 200) {
    const samples = [];
    let next = 0;
    let errors = 0;
    const loop = monitorEventLoopDelay({ resolution: 10 });
    loop.enable();
    const cpu = process.cpuUsage();
    const begin = performance.now();
    await Promise.all(Array.from({ length: 8 }, async () => {
        while (next < count) {
            const index = next++;
            const start = performance.now();
            try { await operation(index); }
            catch { errors++; }
            samples.push(performance.now() - start);
        }
    }));
    const elapsed = performance.now() - begin;
    const used = process.cpuUsage(cpu);
    loop.disable();
    samples.sort((a, b) => a - b);
    const round = value => Math.round(value * 100) / 100;
    console.log(JSON.stringify({ name, count, concurrency: 8, errors, requestsPerSecond: round(count * 1000 / elapsed),
        p95Ms: round(samples[Math.floor(samples.length * 0.95)]), eventLoopP99Ms: round(loop.percentile(99) / 1e6),
        cpuMs: round((used.user + used.system) / 1000), peakRssMiB: round(process.resourceUsage().maxRSS / 1024) }));
    assert.equal(errors, 0);
}

async function main() {
    await docker('network', 'create', prefix);
    networkCreated = true;
    const primary = await container('primary', ['redis-server', '--save', '', '--appendonly', 'no', '--requirepass', 'test-data-password']);
    const replica = await container('replica', ['redis-server', '--save', '', '--appendonly', 'no', '--replicaof', primary.ip, '6379',
        '--masterauth', 'test-data-password', '--requirepass', 'test-data-password']);
    const sentinels = [];
    for (let i = 0; i < 3; i++) {
        sentinels.push(await container('sentinel-' + i, ['sh', '-c',
            'printf "%s\n" "$@" > /tmp/sentinel.conf; exec redis-server /tmp/sentinel.conf --sentinel', 'sh',
            'port 26379', 'bind 0.0.0.0', 'protected-mode no', 'requirepass test-sentinel-password',
            'sentinel sentinel-pass test-sentinel-password',
            `sentinel monitor bgs ${primary.ip} 6379 2`, 'sentinel auth-pass bgs test-data-password',
            'sentinel down-after-milliseconds bgs 1000', 'sentinel failover-timeout bgs 5000']));
    }
    const env = {
        REDIS_SENTINELS: JSON.stringify([{ host: '127.0.0.1', port: 1 }, ...sentinels.map(({ ip }) => ({ host: ip, port: 26379 }))]),
        REDIS_MASTER_NAME: 'bgs', REDIS_PASSWORD: 'test-data-password', REDIS_SENTINEL_PASSWORD: 'test-sentinel-password'
    };
    for (let i = 0; i < 2; i++) {
        const store = new RedisStore({ env, logger, onFatal: error => { throw error; } });
        stores.push(store);
        await store.connect();
    }
    const [first, second] = stores;
    const direct = createClient({ socket: { host: primary.ip }, password: env.REDIS_PASSWORD, disableOfflineQueue: true });
    direct.on('error', () => {});
    clients.push(direct);
    await direct.connect();
    await eventually(async () => assert.match(await direct.info('replication'), /connected_slaves:1/));
    await first.createLoginTicket('shared', 'WoW');
    const originalTTL = await direct.pTTL(LOGIN_PREFIX + 'shared');
    assert.ok(originalTTL > 295000 && originalTTL <= 300000);
    await assert.rejects(first.createLoginTicket('shared', 'Other'));
    assert.equal((await second.getLoginTicket('shared')).program, 'WoW');
    const results = await Promise.allSettled([
        first.authorizeLoginTicket('shared', '9007199254740993'), second.authorizeLoginTicket('shared', '9007199254740995')
    ]);
    assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
    const authorized = await second.getLoginTicket('shared');
    await second.authorizeLoginTicket('shared', authorized.accountId);
    assert.ok(await direct.pTTL(LOGIN_PREFIX + 'shared') <= originalTTL);
    assert.deepEqual(await first.getLoginTicket('shared'), authorized);
    await first.setJSON('/aurora/services/GameUtilitiesService/realmListTickets/example', { identity: '9007199254740993' });
    assert.equal(await direct.ttl('/aurora/services/GameUtilitiesService/realmListTickets/example'), -1);
    assert.deepEqual(await second.getJSON('/aurora/services/GameUtilitiesService/realmListTickets/example'), { identity: '9007199254740993' });
    await first.setMetadata('/aurora/services/AuthenticationService/hash', 0x0decfc01);
    await first.setMetadata('/aurora/services/AuthenticationService/WebAuthUrl', 'https://example.test/login/');
    assert.equal(await second.getMetadata('/aurora/services/AuthenticationService/hash'), String(0x0decfc01));

    let releasePassword;
    let passwordStarted;
    const passwordCheck = new Promise(resolve => { passwordStarted = resolve; });
    const app = createRestApp({ models: { Account: { findOne: async () => ({ id: '9007199254740993', hash: 'controlled' }) } },
        store: first, logger, isReady: readiness({ store: first, sequelize: { authenticate: async () => {} }, isStarted: () => true }),
        compare: () => { passwordStarted(); return new Promise(resolve => { releasePassword = resolve; }); } });
    httpServer = app.listen(0, '127.0.0.1');
    await once(httpServer, 'listening');
    const url = `http://127.0.0.1:${httpServer.address().port}`;
    await first.createLoginTicket('expires', 'WoW');
    const login = fetch(url + '/bnetserver/login/expires', { method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ inputs: [{ input_id: 'account_name', value: 'test@example.test' }, { input_id: 'password', value: 'test' }] }) });
    await passwordCheck;
    await direct.pExpire(LOGIN_PREFIX + 'expires', 1);
    await delay(20);
    releasePassword(true);
    assert.equal((await login).status, 500);
    assert.equal(await second.getLoginTicket('expires'), null);
    assert.equal((await fetch(url + '/alive')).status, 200);
    await eventually(async () => assert.equal((await fetch(url + '/ready')).status, 200));

    for (let i = 0; i < 100; i++) {
        await first.setMetadata(`/aurora/services/WoWService/subRegions/1-1-0/virtualRealms/1-1-${i}`,
            JSON.stringify({ update: { name: `Realm ${i}` }, gameServerId: '1' }));
    }
    const discovery = () => first.listMetadataJSON('/aurora/services/WoWService/subRegions/');
    for (let i = 0; i < 25; i++) { await discovery(); }
    await measure('Redis metadata discovery, empty ticket population', discovery);
    for (let i = 0; i < 10000; i += 100) {
        await Promise.all(Array.from({ length: 100 }, (_, offset) => first.setJSON(`/benchmark/ticket/${i + offset}`, { identity: 'test' })));
    }
    await measure('Redis metadata discovery, 10000 tickets', discovery);
    await measure('Redis login ticket create/read/authorize/verify', async i => {
        const ticket = `benchmark-${i}`;
        await first.createLoginTicket(ticket, 'WoW');
        await second.getLoginTicket(ticket);
        await second.authorizeLoginTicket(ticket, '9007199254740993');
        assert.equal((await first.getLoginTicket(ticket)).accountId, '9007199254740993');
    });
    // Ensure the replica has applied the fixture before deliberately killing the primary.
    assert.equal(await direct.wait(1, 5000), 1);
    console.log('Testing primary loss');
    await docker('stop', '-t', '0', primary.name);
    const failedWriteStart = performance.now();
    await assert.rejects(first.setMetadata('/must-not-replay', 'value'));
    assert.ok(performance.now() - failedWriteStart < 2500);
    assert.equal((await fetch(url + '/alive')).status, 200);
    assert.equal((await fetch(url + '/ready')).status, 500);
    await eventually(async () => {
        assert.equal(await first.ping(), 'PONG');
        assert.equal(await second.ping(), 'PONG');
        assert.equal(first.client.getMasterNode().host, replica.ip);
    });
    console.log('Both clients rediscovered the promoted primary');
    await eventually(async () => assert.equal((await fetch(url + '/ready')).status, 200));
    assert.equal(await first.getMetadata('/must-not-replay'), null);
    assert.equal((await second.getLoginTicket('shared')).accountId, authorized.accountId);
    await second.createLoginTicket('after-failover', 'WoW');
    assert.equal((await first.getLoginTicket('after-failover')).program, 'WoW');
    console.log('Testing Sentinel seed loss');
    await docker('stop', '-t', '0', sentinels[0].name);
    await eventually(async () => {
        assert.equal(await first.ping(), 'PONG');
        assert.equal(await second.ping(), 'PONG');
    });
    await first.close();
    await assert.rejects(first.getLoginTicket('shared'));
    assert.equal((await second.getLoginTicket('shared')).accountId, authorized.accountId);
    console.log('Sentinel integration passed: credentials, unavailable seed, cross-client state, expiry race, failover, no replay, independent shutdown');
}

main().catch(async error => {
    console.error(error);
    process.exitCode = 1;
    for (const name of containers) {
        console.error(name, await docker('logs', '--tail', '8', name).catch(() => 'logs unavailable'));
    }
}).finally(async () => {
    httpServer?.closeAllConnections();
    httpServer?.close();
    await Promise.allSettled(stores.map(store => store.destroy()));
    clients.forEach(client => { if (client.isOpen) { client.destroy(); } });
    await Promise.allSettled(containers.map(name => docker('rm', '-f', name)));
    if (networkCreated) { await docker('network', 'rm', prefix); }
});
