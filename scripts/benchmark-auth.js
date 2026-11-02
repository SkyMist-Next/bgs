'use strict';

// Controlled comparison only: MySQL/Redis are substitutes; bcrypt and HTTP are real.
const assert = require('node:assert/strict');
const { fork } = require('node:child_process');
const { once } = require('node:events');
const { monitorEventLoopDelay, performance } = require('node:perf_hooks');
const { setTimeout: delay } = require('node:timers/promises');
const bcrypt = require('bcrypt');
const createRestApp = require('../utils/rest-app');
const count = 64;
const concurrency = 8;
const rounds = 10;
const percentile = (values, fraction) => [...values].sort((a, b) => a - b)[Math.min(values.length - 1, Math.floor(values.length * fraction))];
const rounded = value => Math.round(value * 100) / 100;

async function serve(mode) {
    const hash = await bcrypt.hash('benchmark-password', rounds);
    const dependencies = {
        models: { Account: { findOne: async () => ({ id: '9007199254740993', hash }) } },
        store: {
            getLoginTicket: async () => ({ ticket: 'benchmark-ticket', program: 'WoW' }),
            authorizeLoginTicket: async () => {}
        },
        logger: { info() {}, debug() {}, error() {} }, isReady: () => true,
        compare: mode === 'sync-baseline' ? (password, stored) => bcrypt.compareSync(password, stored) : bcrypt.compare
    };
    let runtime;
    let server;
    if (mode === 'networking') {
        runtime = require('../rest').createServer({
            config: { environment: 'test', host: '127.0.0.1', port: 0 }, logger: dependencies.logger,
            factories: {
                database: () => ({ ...dependencies.models, sequelize: { authenticate: async () => {}, close: async () => {} } }),
                store: () => ({ ...dependencies.store, healthy: true, connect: async () => {}, ping: async () => {}, close: async () => {}, destroy: async () => {} }),
                compare: dependencies.compare
            }
        });
        await runtime.start();
        server = runtime.listener;
    }
    else {
        server = createRestApp(dependencies).listen(0, '127.0.0.1');
        await once(server, 'listening');
    }
    const loop = monitorEventLoopDelay({ resolution: 10 });
    loop.enable();
    const cpu = process.cpuUsage();
    process.send({ url: `http://127.0.0.1:${server.address().port}` });
    process.once('message', async () => {
        const used = process.cpuUsage(cpu);
        loop.disable();
        process.send({
            cpuMs: rounded((used.user + used.system) / 1000),
            peakRssMiB: rounded(process.resourceUsage().maxRSS / 1024),
            eventLoopP99Ms: rounded(loop.percentile(99) / 1e6)
        });
        if (runtime) { await runtime.stop(); }
        else {
            server.closeAllConnections();
            await new Promise(resolve => server.close(resolve));
        }
        process.disconnect();
    });
}

async function measure(mode) {
    const child = fork(__filename, [mode], { stdio: ['ignore', 'inherit', 'inherit', 'ipc'] });
    // Bound failures without making a timing threshold part of acceptance.
    const timeout = setTimeout(() => child.kill('SIGKILL'), 30000);
    try {
        const [{ url }] = await once(child, 'message');
        const loginMs = [];
        const healthMs = [];
        let done = false;
        let next = 0;
        let errors = 0;
        const probe = (async () => {
            while (!done) {
                const start = performance.now();
                const response = await fetch(url + '/alive');
                await response.text();
                if (response.status !== 200) { errors++; }
                healthMs.push(performance.now() - start);
                await delay(10);
            }
        })();
        const start = performance.now();
        await Promise.all(Array.from({ length: concurrency }, async () => {
            while (next++ < count) {
                const began = performance.now();
                const response = await fetch(url + '/bnetserver/login/ticket', {
                    method: 'POST', headers: { 'content-type': 'application/json' },
                    body: JSON.stringify({ inputs: [
                        { input_id: 'account_name', value: 'benchmark@example.test' },
                        { input_id: 'password', value: 'benchmark-password' }
                    ] })
                });
                const result = await response.json();
                if (response.status !== 200 || result.authentication_state !== 'DONE') { errors++; }
                loginMs.push(performance.now() - began);
            }
        }));
        const elapsedMs = performance.now() - start;
        done = true;
        await probe;
        const metrics = once(child, 'message');
        const exited = once(child, 'exit');
        child.send('stop');
        const [resources] = await metrics;
        const [exitCode] = await exited;
        assert.equal(exitCode, 0);
        return {
            mode, count, concurrency, bcryptRounds: rounds, errors,
            requestsPerSecond: rounded(count * 1000 / elapsedMs),
            loginP95Ms: rounded(percentile(loginMs, 0.95)),
            healthP95Ms: rounded(percentile(healthMs, 0.95)), ...resources
        };
    }
    finally {
        clearTimeout(timeout);
        if (child.exitCode === null) { child.kill(); }
    }
}

async function main() {
    if (process.argv[2]) {
        await serve(process.argv[2]);
    }
    else {
        console.log(JSON.stringify({ node: process.version, platform: process.platform, arch: process.arch,
            uvThreadpoolSize: process.env.UV_THREADPOOL_SIZE || '4 (default)' }));
        for (const mode of ['sync-baseline', 'async', 'networking']) {
            console.log(JSON.stringify(await measure(mode)));
        }
    }
}

main().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
