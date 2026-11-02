'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { once } = require('node:events');
const tls = require('node:tls');
const { TlsCredentials, validate } = require('../utils/tls-credentials');

test('TLS files rotate coherently, retain working material on failure, and preserve sessions', async t => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'bgs-tls-rotation-'));
    t.after(() => fs.rm(directory, { recursive: true, force: true }));
    for (const generation of ['one', 'two']) {
        await fs.mkdir(path.join(directory, generation));
        execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1',
            '-subj', '/CN=bgs.local', '-addext', 'subjectAltName=DNS:bgs.local', '-addext', 'basicConstraints=CA:FALSE',
            '-keyout', path.join(directory, generation, 'tls.key'), '-out', path.join(directory, generation, 'tls.crt')], { stdio: 'ignore' });
    }
    await fs.symlink('one', path.join(directory, 'current'));
    const controller = new TlsCredentials({ tlsCertFile: path.join(directory, 'current/tls.crt'),
        tlsKeyFile: path.join(directory, 'current/tls.key'), tlsServerName: 'bgs.local', tlsReloadIntervalMs: 100000 });
    const first = await controller.initialize();
    assert.throws(() => validate(first, 'wrong.local'), /hostname/);
    const secondKey = await fs.readFile(path.join(directory, 'two/tls.key'));
    assert.throws(() => validate({ ...first, key: secondKey }, 'bgs.local'), /match/);
    const server = tls.createServer(first, socket => socket.pipe(socket));
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    controller.start(server);
    const sockets = [];
    t.after(async () => { controller.stop(); sockets.forEach(socket => socket.destroy()); await new Promise(resolve => server.close(resolve)); });
    const connect = async () => {
        const socket = tls.connect({ host: '127.0.0.1', port: server.address().port, servername: 'bgs.local',
            ca: [first.cert, await fs.readFile(path.join(directory, 'two/tls.crt'))], rejectUnauthorized: true });
        sockets.push(socket);
        await once(socket, 'secureConnect');
        return socket;
    };
    const old = await connect();
    const fingerprint = old.getPeerX509Certificate().fingerprint256;
    await fs.symlink('two', path.join(directory, 'next'));
    await fs.rename(path.join(directory, 'next'), path.join(directory, 'current'));
    await controller.reload();
    const fresh = await connect();
    assert.notEqual(fresh.getPeerX509Certificate().fingerprint256, fingerprint);
    old.write('still connected');
    assert.equal((await once(old, 'data'))[0].toString(), 'still connected');
    const active = controller.active;
    await fs.writeFile(path.join(directory, 'two/tls.key'), 'invalid');
    await controller.reload();
    assert.equal(controller.active, active);
    assert.equal(controller.valid(), true);
    await fs.writeFile(path.join(directory, 'two/tls.key'), secondKey);
    controller.active = { ...active, certificate: { validTo: '2000-01-01' } };
    assert.equal(controller.valid(), false);
    // A valid unchanged candidate must also recover an expired active identity.
    controller.active = { ...controller.active, digest: 'expired' };
    await controller.reload();
    assert.equal(controller.valid(), true);
    controller.stop();
    await fs.writeFile(path.join(directory, 'two/tls.key'), 'invalid');
    await controller.reload();
    assert.equal(controller.valid(), true);
});

test('credential validation and reload failures do not require a listener', async t => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'bgs-tls-loader-'));
    t.after(() => fs.rm(directory, { recursive: true, force: true }));
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1',
        '-subj', '/CN=bgs.local', '-addext', 'subjectAltName=DNS:bgs.local', '-addext', 'basicConstraints=CA:FALSE',
        '-keyout', path.join(directory, 'tls.key'), '-out', path.join(directory, 'tls.crt')], { stdio: 'ignore' });
    const config = { tlsCertFile: path.join(directory, 'tls.crt'), tlsKeyFile: path.join(directory, 'tls.key'), tlsServerName: 'bgs.local' };
    const errors = [];
    const controller = new TlsCredentials(config, { info() {}, error: message => errors.push(message) });
    const credentials = await controller.initialize();
    assert.throws(() => validate(credentials, 'wrong.local'), /hostname/);
    assert.throws(() => validate({ ...credentials, cert: 'bad' }), /./);
    let activations = 0;
    controller.server = { setSecureContext: () => { activations++; } };
    await fs.writeFile(config.tlsCertFile, Buffer.concat([credentials.cert, Buffer.from('\n')]));
    await controller.reload();
    assert.equal(activations, 1);
    const original = controller.active;
    controller.server = { setSecureContext: () => assert.fail('Unchanged/invalid credentials must not activate') };
    await controller.reload();
    await fs.writeFile(config.tlsKeyFile, 'bad');
    await controller.reload();
    await controller.reload();
    assert.equal(controller.active, original);
    assert.equal(errors.length, 1);
    await fs.writeFile(config.tlsKeyFile, credentials.key);
    await controller.reload();
    assert.equal(controller.failed, false);
    const missing = new TlsCredentials({ tlsCertFile: path.join(directory, 'absent') });
    await assert.rejects(missing.initialize());
    controller.active = { ...original, certificate: { validTo: '2000-01-01' } };
    assert.equal(controller.valid(), false);
    controller.stop();
    controller.server = { setSecureContext: () => assert.fail('Stopped reload must not activate') };
    controller.active.digest = 'changed';
    await controller.reload();
    assert.equal(controller.valid(), false);
});

test('TLS expiry changes readiness independently of existing application admission', () => {
    const NetworkingServer = require('../servers/networking-server');
    const server = new NetworkingServer({ requiresAmqp: false, plugin: {
        initialize() {}, stopAccepting() {}, drain() {}, forceClose() {}
    } });
    server.state = 'running'; server.sqlHealthy = true; server.dependencies.store = { healthy: true };
    let valid = false;
    server.tlsCredentials = { valid: () => valid };
    assert.equal(server.isServing(), false);
    assert.equal(server.isAccepting(), true);
    valid = true;
    assert.equal(server.isServing(), true);
});
