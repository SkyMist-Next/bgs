'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { once } = require('node:events');
const { execFileSync } = require('node:child_process');
const http = require('node:http');
const https = require('node:https');
const net = require('node:net');
const tls = require('node:tls');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { performance } = require('node:perf_hooks');
const { fixture, deferred, tick } = require('./support/server-fixture');
const NetworkingServer = require('../servers/networking-server');
const ServiceServer = require('../servers/service-server');
const rest = require('../rest');
const frontend = require('../frontend');
const worker = require('../server');
const Header = require('../utils/protobuf')('proto/bgs/low/pb/client/rpc_types.proto').lookupType('bgs.protocol.Header');
const inputs = [{ input_id: 'account_name', value: 'demo@example.test' }, { input_id: 'password', value: 'password' }];
const payload = JSON.stringify({ inputs });

function request(server, route = '/alive', { method = 'GET', agent, body } = {}) {
    const client = server.config.environment === 'development' ? https : http;
    return new Promise((resolve, reject) => {
        const req = client.request({ hostname: '127.0.0.1', port: server.listener.address().port,
            path: route, method, agent, rejectUnauthorized: false,
            headers: body ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) } : {} }, res => {
            let data = '';
            res.on('data', chunk => { data += chunk; });
            res.on('end', () => resolve({ status: res.statusCode, data, headers: res.headers }));
        });
        req.on('error', reject);
        req.end(body);
    });
}

function rpcFrame(serviceHash) {
    const header = Header.encode(Header.fromObject({ serviceId: 0, serviceHash, methodId: 1, token: 7, size: 0 })).finish();
    const frame = Buffer.alloc(header.length + 2);
    frame.writeUInt16BE(header.length);
    header.copy(frame, 2);
    return frame;
}

async function clientConnection(server, t) {
    const socket = net.connect(server.listener.address().port, '127.0.0.1');
    socket.on('error', () => {});
    t.after(() => socket.destroy());
    await once(socket, 'connect');
    while (!server.plugin.service.connections.length) { await tick(); }
    return { socket, connection: server.plugin.service.connections[0] };
}

test('entrypoint imports do not read operator configuration, connect, or register process handlers', () => {
    execFileSync(process.execPath, ['-e', `
        const assert = require('node:assert/strict');
        const { registerHooks } = require('node:module');
        const before = ['SIGINT', 'SIGTERM', 'unhandledRejection'].map(event => process.listenerCount(event));
        const hooks = registerHooks({ resolve(specifier, context, next) {
            assert.ok(!specifier.includes('config/'));
            return next(specifier, context);
        } });
        for (const file of ['frontend', 'rest', 'server']) { assert.equal(typeof require('./' + file).createServer, 'function'); }
        assert.deepEqual(['SIGINT', 'SIGTERM', 'unhandledRejection'].map(event => process.listenerCount(event)), before);
        hooks.deregister();
    `], { cwd: path.resolve(__dirname, '..'), timeout: 5000 });
});

test('plugin contract is validated before dependency acquisition', () => {
    const state = fixture();
    assert.throws(() => new NetworkingServer({ ...state.options, plugin: { initialize() {} } }), /stopAccepting/);
    assert.deepEqual(state.events, []);
});

test('REST binds only after dependencies and metadata, exposes health/login, and does not acquire RabbitMQ', async t => {
    const state = fixture({ webAuthUrl: 'http://example.test/login/' });
    const sql = deferred();
    state.models.sequelize.authenticate = () => sql.promise;
    const metadata = deferred();
    state.store.setMetadata = (key, value) => {
        assert.equal(key, '/aurora/services/AuthenticationService/WebAuthUrl');
        assert.equal(value, state.options.config.webAuthUrl);
        state.events.push('metadata');
        return metadata.promise;
    };
    const server = rest.createServer(state.options);
    t.after(() => server.stop());
    assert.ok(server instanceof NetworkingServer);
    const started = server.start();
    await tick();
    assert.equal(server.listener, undefined);
    assert.equal(await server.isReady(), false);
    sql.resolve();
    await tick();
    assert.ok(state.events.includes('metadata'));
    assert.equal(server.listener, undefined);
    metadata.resolve();
    await started;
    assert.equal((await request(server)).status, 200);
    assert.equal((await request(server, '/ready')).status, 200);
    const response = await request(server, '/bnetserver/login/ticket', { method: 'POST', body: payload });
    assert.deepEqual(JSON.parse(response.data), { login_ticket: 'ticket', authentication_state: 'DONE' });
    state.store.healthy = false;
    assert.equal((await request(server, '/ready')).status, 500);
    assert.equal((await request(server, '/bnetserver/login/ticket', { method: 'POST', body: payload })).status, 500);
    assert.equal((await request(server)).status, 200);
    assert.ok(!state.events.includes('amqp.create'));
});

test('real bind failures clean dependencies and preserve the original listener', async t => {
    const occupied = net.createServer();
    occupied.listen(0, '127.0.0.1');
    await once(occupied, 'listening');
    t.after(() => new Promise(resolve => occupied.close(resolve)));
    for (const entry of [rest, frontend]) {
        const state = fixture({ port: occupied.address().port });
        const server = entry.createServer(state.options);
        await assert.rejects(server.start(), /EADDRINUSE|stopping/);
        assert.equal((await server.closed).exitCode, 1);
        assert.ok(state.events.includes('redis.close'));
        assert.ok(state.events.includes('sql.close'));
        assert.equal(occupied.listening, true);
    }
});

test('REST drains active keep-alive authentication and retires idle connections before dependency cleanup', async t => {
    const state = fixture({ shutdownTimeout: 500 });
    const compare = deferred();
    const entered = deferred();
    state.options.factories.compare = () => { entered.resolve(); return compare.promise; };
    const server = rest.createServer(state.options);
    t.after(() => server.stop());
    await server.start();
    const agent = new http.Agent({ keepAlive: true });
    t.after(() => agent.destroy());
    await request(server, '/alive', { agent });
    const response = request(server, '/bnetserver/login/ticket', { method: 'POST', body: payload, agent });
    await entered.promise;
    const began = performance.now();
    const closing = server.stop();
    await tick();
    assert.ok(!state.events.includes('sql.close'));
    compare.resolve(true);
    assert.equal((await response).status, 200);
    assert.deepEqual(await closing, { exitCode: 0, forced: false, errors: [] });
    assert.ok(state.events.indexOf('authorize') < state.events.indexOf('sql.close'));
    t.diagnostic('Active HTTP shutdown ms: ' + (performance.now() - began).toFixed(2));
});

test('client disconnect does not release ownership of an asynchronous authentication handler', async t => {
    const state = fixture({ shutdownTimeout: 500 });
    const compare = deferred();
    const entered = deferred();
    state.options.factories.compare = () => { entered.resolve(); return compare.promise; };
    const server = rest.createServer(state.options);
    t.after(() => server.stop());
    await server.start();
    const req = http.request({ host: '127.0.0.1', port: server.listener.address().port,
        path: '/bnetserver/login/ticket', method: 'POST', headers: { 'content-type': 'application/json' } });
    req.on('error', () => {});
    req.end(payload);
    await entered.promise;
    req.destroy();
    const closing = server.stop();
    await tick();
    assert.equal(server.plugin.pending.size, 1);
    assert.ok(!state.events.includes('redis.close'));
    compare.resolve(true);
    assert.equal((await closing).forced, false);
    assert.ok(state.events.indexOf('authorize') < state.events.indexOf('redis.close'));
});

test('a plugin listener returned after forced shutdown is closed without binding', async () => {
    const state = fixture({ shutdownTimeout: 15, forceTimeout: 10 });
    const initialized = deferred();
    let forced = 0;
    const plugin = { initialize: () => initialized.promise, stopAccepting() {}, drain: async () => {}, forceClose: () => { forced++; } };
    const server = new NetworkingServer({ ...state.options, plugin });
    const rejected = assert.rejects(server.start(), /stopping/);
    await tick();
    assert.equal((await server.stop()).forced, true);
    const listener = net.createServer();
    let bound = false;
    listener.on('listening', () => { bound = true; });
    initialized.resolve(listener);
    await rejected;
    await tick();
    assert.equal(bound, false);
    assert.equal(listener.listening, false);
    assert.ok(forced >= 2);
});

test('TCP drains a pending worker reply and socket output before closing its channel and broker', async t => {
    const state = fixture({ shutdownTimeout: 500 });
    const server = frontend.createServer(state.options);
    t.after(() => server.stop());
    await server.start();
    const { socket, connection } = await clientConnection(server, t);
    connection.setBindlessRPC(true);
    connection.setAmqpChannel(state.channel);
    connection.setAmqpQueueName('queue');
    await connection.setupConsumer();
    const published = deferred();
    state.channel.publish = () => { state.events.push('publish'); published.resolve(); return true; };
    socket.write(rpcFrame(123));
    await published.promise;
    assert.equal(connection.inFlight, 1);
    const output = once(socket, 'data');
    const closing = server.stop();
    await tick();
    assert.ok(!state.events.includes('channel.close'));
    assert.ok(!state.events.includes('amqp.close'));
    state.channel.deliver({ properties: { type: 'response' }, content: Buffer.from('worker reply') });
    assert.equal((await output)[0].toString(), 'worker reply');
    assert.equal((await closing).forced, false);
    assert.ok(state.events.indexOf('ack') < state.events.indexOf('channel.close'));
    assert.ok(state.events.indexOf('channel.close') < state.events.indexOf('amqp.close'));
});

test('stalled TCP output forces socket cleanup within the total deadline', async t => {
    const state = fixture({ shutdownTimeout: 20, forceTimeout: 15 });
    const server = frontend.createServer(state.options);
    t.after(() => server.stop());
    await server.start();
    const { connection } = await clientConnection(server, t);
    // A real listener/socket with controlled backpressure completion.
    connection.socket.write = () => false;
    void connection.writeBuffer(Buffer.from('pending output'));
    const began = performance.now();
    const result = await server.stop();
    assert.equal(result.forced, true);
    assert.equal(result.exitCode, 1);
    assert.equal(connection.socket.destroyed, true);
    assert.ok(performance.now() - began < 500);
    t.diagnostic('Stalled TCP shutdown ms: ' + (performance.now() - began).toFixed(2));
});

test('client-owned channel failure and consumer cancellation disconnect only that client', async t => {
    const state = fixture();
    const server = frontend.createServer(state.options);
    t.after(() => server.stop());
    await server.start();
    for (const failure of ['error', 'cancel']) {
        const { socket, connection } = await clientConnection(server, t);
        connection.setAmqpChannel(state.channel);
        connection.setAmqpQueueName('queue');
        await connection.setupConsumer();
        const disconnected = once(socket, 'close');
        if (failure === 'error') { state.channel.emit('error', new Error('channel failed')); }
        else { state.channel.deliver(null); }
        await disconnected;
        assert.equal(server.state, 'running');
        assert.equal(await server.isReady(), true);
    }
});

class TestService {
    getServiceName() { return 'TestService'; }
    getServiceHash() { return 123; }
    async handleCall() { return Buffer.from('reply'); }
    async sendError() { return Buffer.from('error'); }
}

test('workers become ready after consumer startup, cancel late consumers, and fail on broker/channel/consumer loss', async () => {
    for (const failure of ['broker', 'channel', 'cancel']) {
        const state = fixture();
        const registration = deferred();
        state.channel.consume = (queue, callback) => { state.channel.deliver = callback; return registration.promise; };
        const server = worker.createServer({ ...state.options, Service: TestService });
        assert.ok(server instanceof ServiceServer);
        const started = server.start();
        await tick();
        assert.equal(await server.isReady(), false);
        registration.resolve({ consumerTag: 'tag' });
        await started;
        assert.equal(await server.isReady(), true);
        if (failure === 'broker') { state.amqp.emit('close'); }
        if (failure === 'channel') { state.channel.emit('close'); }
        if (failure === 'cancel') { state.channel.deliver(null); }
        assert.equal((await server.closed).exitCode, 1);
        assert.ok(state.events.includes('channel.close'));
    }
});

test('worker startup cancellation owns a channel and consumer that complete after force cleanup', async () => {
    for (const phase of ['channel', 'consumer']) {
        const state = fixture({ shutdownTimeout: 10 });
        const opening = deferred();
        if (phase === 'channel') { state.amqp.createChannel = () => opening.promise; }
        else { state.channel.consume = () => opening.promise; }
        const server = worker.createServer({ ...state.options, Service: TestService });
        const rejected = assert.rejects(server.start(), /stopping/);
        await tick();
        assert.equal((await server.stop()).forced, true);
        opening.resolve(phase === 'channel' ? state.channel : { consumerTag: 'tag' });
        await rejected;
        await tick();
        assert.equal(state.events.filter(event => event === 'channel.close').length, 1);
    }
});

test('development HTTPS/TLS work and forced cleanup includes unfinished TLS handshakes', async t => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'bgs-server-tls-'));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1',
        '-subj', '/CN=localhost', '-keyout', path.join(directory, 'key'), '-out', path.join(directory, 'cert')], { stdio: 'ignore' });
    const credentials = { key: fs.readFileSync(path.join(directory, 'key')), cert: fs.readFileSync(path.join(directory, 'cert')) };
    const web = rest.createServer(fixture({ environment: 'development', tls: credentials }).options);
    await web.start();
    assert.equal((await request(web, '/alive')).status, 200);
    assert.equal((await request(web, '/ready')).status, 200);
    assert.equal((await request(web, '/bnetserver/login/ticket', { method: 'POST', body: payload })).status, 200);
    await web.stop();
    for (const entry of [rest, frontend]) {
        const server = entry.createServer(fixture({ environment: 'development', tls: credentials, shutdownTimeout: 20 }).options);
        t.after(() => server.stop());
        await server.start();
        if (entry === frontend) {
            const client = tls.connect({ host: '127.0.0.1', port: server.listener.address().port, rejectUnauthorized: false });
            await once(client, 'secureConnect');
            client.destroy();
        }
        const raw = net.connect(server.listener.address().port, '127.0.0.1');
        t.after(() => raw.destroy());
        await once(raw, 'connect');
        const closed = once(raw, 'close');
        const result = await server.stop();
        await closed;
        assert.equal(result.forced, true);
    }
});


test('a stalled authentication dependency is forced closed within the shutdown budget', async t => {
    const state = fixture({ shutdownTimeout: 20, forceTimeout: 15 });
    const compare = deferred();
    const entered = deferred();
    state.options.factories.compare = () => { entered.resolve(); return compare.promise; };
    const server = rest.createServer(state.options);
    await server.start();
    const response = request(server, '/bnetserver/login/ticket', { method: 'POST', body: payload });
    const disconnected = assert.rejects(response, /socket hang up|ECONNRESET/);
    await entered.promise;
    const began = performance.now();
    const result = await server.stop();
    await disconnected;
    assert.equal(result.forced, true);
    assert.equal(result.exitCode, 1);
    assert.ok(state.events.includes('redis.destroy'));
    assert.ok(state.events.includes('sql.close'));
    // Complete the deliberately stalled fake without publishing a successful login.
    compare.resolve(false);
    await tick();
    assert.ok(!state.events.includes('authorize'));
    t.diagnostic('Stalled authentication shutdown ms: ' + (performance.now() - began).toFixed(2));
});

test('a client channel acquired after disconnect is closed before shared RabbitMQ during drain', async t => {
    const state = fixture({ shutdownTimeout: 500 });
    const opened = deferred();
    const closed = deferred();
    const entered = deferred();
    state.amqp.createChannel = () => { entered.resolve(); return opened.promise; };
    state.channel.close = () => { state.events.push('channel.close'); return closed.promise; };
    const server = frontend.createServer(state.options);
    await server.start();
    t.after(() => server.stop());
    const { connection, socket } = await clientConnection(server, t);
    const service = server.plugin.service;
    const requestType = service.rootNamespace.lookupType('bgs.protocol.connection.v1.ConnectRequest');
    const requestBuffer = requestType.encode(requestType.fromObject({ useBindlessRpc: true })).finish();
    service.onMessage({ methodId: 1, token: 1, serviceId: 0 }, requestBuffer, connection);
    await entered.promise;
    const socketClosed = once(connection.socket, 'close');
    socket.destroy();
    await socketClosed;
    const stopping = server.stop();
    opened.resolve(state.channel);
    await tick();
    assert.ok(state.events.includes('channel.close'));
    assert.ok(!state.events.includes('amqp.close'));
    closed.resolve();
    assert.equal((await stopping).forced, false);
    assert.ok(state.events.indexOf('channel.close') < state.events.indexOf('amqp.close'));
});


test('TCP drain retains broker backpressure on client responses', async t => {
    const state = fixture({ shutdownTimeout: 500 });
    const server = frontend.createServer(state.options);
    await server.start();
    t.after(() => server.stop());
    const { socket, connection } = await clientConnection(server, t);
    connection.setBindlessRPC(true);
    connection.setAmqpChannel(state.channel);
    const published = deferred();
    state.channel.publish = () => { published.resolve(); return false; };
    const header = Header.encode(Header.fromObject({ serviceId: 0xFE, serviceHash: 123, token: 0, size: 0 })).finish();
    const frame = Buffer.alloc(header.length + 2);
    frame.writeUInt16BE(header.length);
    header.copy(frame, 2);
    socket.write(frame);
    await published.promise;
    const stopping = server.stop();
    await tick();
    assert.ok(!state.events.includes('channel.close'));
    state.channel.emit('drain');
    assert.equal((await stopping).forced, false);
    assert.ok(state.events.indexOf('channel.close') < state.events.indexOf('amqp.close'));
});
