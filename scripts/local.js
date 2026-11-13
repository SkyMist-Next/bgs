'use strict';

const { spawn } = require('node:child_process');
const { once } = require('node:events');
const path = require('node:path');
const net = require('node:net');
const https = require('node:https');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');

const CONTEXT = 'minikube';
const NAMESPACE = 'bgs-test';
const NAME = 'bgs-test-bgs';
const SECRET = 'bgs-test-local-account';
const EMAIL = 'bgs-local@example.invalid';
const WEB_URL = 'https://bgs.local:8443/bnetserver/login/';
const root = path.resolve(__dirname, '..');
const children = new Set();
const baseArgs = ['--context', CONTEXT, '--request-timeout=15s', '-n', NAMESPACE];

function run(args, input, timeout = 30000) {
    return new Promise((resolve, reject) => {
        const child = spawn('kubectl', [...baseArgs, ...args], { stdio: ['pipe', 'pipe', 'pipe'], cwd: root });
        children.add(child);
        let output = '';
        let timedOut = false;
        const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, timeout);
        child.stdout.on('data', data => { output += data; if (output.length > 4 * 1024 * 1024) { child.kill('SIGKILL'); } });
        // kubectl errors can echo manifests containing Secret data. Never include their raw output.
        child.stderr.resume();
        child.stdin.on('error', () => {});
        child.on('error', () => { clearTimeout(timer); children.delete(child); reject(new Error('Cannot execute kubectl')); });
        child.on('close', code => {
            clearTimeout(timer); children.delete(child);
            if (code === 0) { resolve(output); }
            else { reject(new Error(`kubectl ${args.slice(0, 3).join(' ')} ${timedOut ? 'timed out' : 'failed'}; inspect the named local resource`)); }
        });
        child.stdin.end(input);
    });
}
async function get(resource, name, extra = []) {
    return JSON.parse(await run(['get', resource, ...(name ? [name] : []), ...extra, '-o', 'json']));
}
function condition(resource, type) {
    return resource.status?.conditions?.some(item => item.type === type && item.status === 'True' &&
        (item.observedGeneration === undefined || item.observedGeneration === resource.metadata.generation));
}
async function preflight() {
    if (process.env.SKAFFOLD_KUBE_CONTEXT && process.env.SKAFFOLD_KUBE_CONTEXT !== CONTEXT) {
        throw new Error('This local workflow requires --kube-context minikube');
    }
    const version = process.versions.node.split('.').map(Number);
    if (version[0] !== 26 || version[1] < 13) { throw new Error('Select Node.js 26.13.0+ in the 26.x series with nvm use'); }
    await get('namespace', NAMESPACE);
    for (const crd of ['mariadbs.k8s.mariadb.com', 'databases.k8s.mariadb.com', 'users.k8s.mariadb.com',
        'grants.k8s.mariadb.com', 'rabbitmqclusters.rabbitmq.com']) {
        if (!condition(await get('crd', crd), 'Established')) { throw new Error('CRD not established: ' + crd); }
    }
    for (const [namespace, name] of [[NAMESPACE, 'bgs-test-mariadb-mariadb-operator'],
        ['rabbitmq-system', 'rabbitmq-cluster-operator'],
        ['cert-manager', 'bgs-test-cert-manager'], ['cert-manager', 'bgs-test-cert-manager-webhook']]) {
        const deployment = await get('deployment', name, ['-n', namespace]);
        if (!condition(deployment, 'Available')) { throw new Error('Operator unavailable: ' + name); }
    }
    const secret = await get('secret', 'bgs-local-tls');
    if (!secret.data?.['ca.crt']) { throw new Error('Import dev credentials and CA with npm run local:tls'); }
    require('../utils/tls-credentials').validate({ cert: await certificatePem(),
        key: Buffer.from(secret.data?.['tls.key'] || '', 'base64') }, 'bgs.local');
    const certificate = new crypto.X509Certificate(await certificatePem());
    if (!certificate.checkHost('bgs.local') || Date.parse(certificate.validTo) <= Date.now() || Date.parse(certificate.validFrom) > Date.now()) {
        throw new Error('bgs-local-tls must contain a current certificate for bgs.local');
    }
    console.log('Local prerequisites ready: minikube / bgs-test');
}
async function certificatePem() {
    const secret = await get('secret', 'bgs-local-tls');
    if (secret.type !== 'kubernetes.io/tls' || !secret.data?.['tls.key'] || !secret.data?.['tls.crt']) {
        throw new Error('Missing TLS key/certificate in bgs-local-tls');
    }
    return Buffer.from(secret.data['tls.crt'], 'base64');
}

function available(port) {
    return new Promise((resolve, reject) => {
        const server = net.createServer();
        server.once('error', error => error.code === 'EADDRINUSE' ? resolve(false) : reject(error));
        server.listen(port, '127.0.0.1', () => server.close(() => resolve(true)));
    });
}

async function forward(allowExisting = false) {
    const free = await Promise.all([available(1119), available(8443)]);
    if (!free.every(Boolean)) {
        if (allowExisting && free.every(value => !value)) { return async () => {}; }
        throw new Error('Local ports 1119 and 8443 must both be free; stop conflicting forwards first');
    }
    // Frontend and REST are different Pods behind one Service, and a Service port-forward
    // binds a single Pod, so forward each Deployment separately.
    const stops = [];
    try {
        stops.push(await portForward('deployment/' + NAME + '-frontend', '1119:1119'));
        stops.push(await portForward('deployment/' + NAME + '-rest', '8443:8080'));
    }
    catch (error) { await Promise.all(stops.map(item => item())); throw error; }
    const stop = async () => { await Promise.all(stops.map(item => item())); };
    stop.closed = Promise.race(stops.map(item => item.closed));
    console.log('Forwarded: bgs.local:1119 and https://bgs.local:8443');
    return stop;
}

async function portForward(target, mapping) {
    const local = '127.0.0.1:' + mapping.split(':')[0];
    const child = spawn('kubectl', ['--context', CONTEXT, '-n', NAMESPACE, 'port-forward',
        '--address=127.0.0.1', target, mapping], { stdio: ['ignore', 'pipe', 'pipe'] });
    children.add(child);
    const closed = once(child, 'close').catch(() => {});
    child.once('close', () => children.delete(child));
    const stop = async () => {
        child.kill('SIGTERM');
        const timer = setTimeout(() => child.kill('SIGKILL'), 2000);
        await closed;
        clearTimeout(timer);
    };
    try {
        await new Promise((resolve, reject) => {
            let output = '';
            const timer = setTimeout(() => reject(new Error(`Port forwarding to ${target} timed out`)), 15000);
            const failed = () => { clearTimeout(timer); reject(new Error(`Port forwarding to ${target} failed`)); };
            child.once('error', failed);
            child.once('close', failed);
            child.stderr.resume();
            child.stdout.on('data', data => {
                output = (output + data).slice(-4096);
                if (output.includes(local)) {
                    clearTimeout(timer); child.removeListener('close', failed); resolve();
                }
            });
        });
    }
    catch (error) { await stop(); throw error; }
    stop.closed = closed;
    return stop;
}

async function credentials(create = false) {
    const read = async () => {
        const raw = await run(['get', 'secret', SECRET, '--ignore-not-found', '-o', 'json']);
        return raw ? JSON.parse(raw) : null;
    };
    let secret = await read();
    if (!secret && create) {
        const document = { apiVersion: 'v1', kind: 'Secret', metadata: { name: SECRET, namespace: NAMESPACE,
            labels: { 'skymist.io/local-fixture': 'bgs-login' } }, type: 'Opaque',
        stringData: { email: EMAIL, password: crypto.randomBytes(12).toString('base64url') } };
        try { await run(['create', '-f', '-'], JSON.stringify(document)); }
        catch (error) { if (!await read()) { throw error; } } // Another test may have won Secret creation.
        secret = await read();
    }
    if (!secret) { throw new Error('Run npm run test:local to provision the local account first'); }
    const result = Object.fromEntries(['email', 'password'].map(key => [key, Buffer.from(secret.data?.[key] || '', 'base64').toString()]));
    if (secret.metadata.labels?.['skymist.io/local-fixture'] !== 'bgs-login' || result.email !== EMAIL || result.password.length !== 16) {
        throw new Error('Existing fixture Secret is incompatible; refusing to replace it');
    }
    return result;
}

function request(ca, url, body) {
    return new Promise((resolve, reject) => {
        const data = body ? JSON.stringify(body) : undefined;
        const req = https.request(url, { ca, rejectUnauthorized: true, servername: 'bgs.local',
            lookup: (_hostname, _options, callback) => callback(null, [{ address: '127.0.0.1', family: 4 }]),
            method: body ? 'POST' : 'GET', headers: body ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {} }, res => {
            let output = '';
            res.on('data', chunk => { output += chunk; if (output.length > 65536) { req.destroy(new Error('HTTPS response too large')); } });
            res.on('error', () => reject(new Error('HTTPS response interrupted')));
            res.on('end', () => {
                try { resolve({ status: res.statusCode, body: JSON.parse(output) }); }
                catch { reject(new Error('HTTPS response was not JSON')); }
            });
        });
        const timer = setTimeout(() => req.destroy(new Error('HTTPS deadline')), 10000);
        req.on('close', () => clearTimeout(timer));
        req.on('error', () => reject(new Error('HTTPS request or certificate verification failed')));
        req.end(data);
    });
}

async function checkDeployment() {
    const deployments = await get('deployments');
    for (const component of ['frontend', 'rest', 'account', 'authentication', 'game-utilities']) {
        const deployment = deployments.items.find(item => item.metadata.name === `${NAME}-${component}`);
        if (!deployment || !condition(deployment, 'Available') || deployment.status.observedGeneration !== deployment.metadata.generation ||
            deployment.status.updatedReplicas !== deployment.spec.replicas || deployment.status.readyReplicas !== deployment.spec.replicas) {
            throw new Error('BGS deployment is not ready: ' + component);
        }
        if (!deployment.spec.template.spec.containers[0].env.some(env => env.name === 'WEB_AUTH_URL' && env.value === WEB_URL)) {
            throw new Error('Deploy with the local Skaffold configuration before testing');
        }
        await run(['exec', 'deployment/' + deployment.metadata.name, '-c', 'bgs', '--', 'node', '-e',
            'Promise.all(["alive", "ready"].map(async p => { const r = await fetch("http://127.0.0.1:8081/" + p, {signal: AbortSignal.timeout(5000)}); if(r.status !== 200) throw Error(); })).catch(() => {process.exitCode=1;})']);
    }
    const jobs = await get('jobs');
    for (const role of ['bootstrap', 'migrate']) {
        const job = jobs.items.filter(item => item.metadata.name.startsWith(`${NAME}-${role}-`))
            .sort((a, b) => b.metadata.creationTimestamp.localeCompare(a.metadata.creationTimestamp))[0];
        if (!job || !condition(job, 'Complete')) { throw new Error('Latest ' + role + ' Job has not completed'); }
    }
    for (const kind of ['tlsroute', 'tcproute']) {
        const routes = await get(kind);
        const route = routes.items.find(item => item.metadata.name.startsWith(NAME + '-'));
        if (!route?.status?.parents?.some(parent => ['Accepted', 'ResolvedRefs'].every(type =>
            parent.conditions.some(c => c.type === type && c.status === 'True' && c.observedGeneration === route.metadata.generation)))) {
            throw new Error('Gateway route is not accepted: ' + kind);
        }
    }
    console.log('All five services, bootstrap/migration Jobs, and Gateway routes are ready');
}

async function testLogin() {
    await preflight();
    await checkDeployment();
    const secret = await get('secret', 'bgs-local-tls');
    if (!secret.data?.['ca.crt']) { throw new Error('Import the dev CA bundle with npm run local:tls'); }
    const ca = Buffer.from(secret.data['ca.crt'], 'base64');
    const identity = await credentials(true);
    const fixture = JSON.parse(await run(['exec', '-i', 'deployment/' + NAME + '-rest', '-c', 'bgs', '--',
        'node', 'scripts/local-fixture.js'], JSON.stringify(identity), 45000));
    const stop = await forward(true);
    let client;
    try {
        const rpc = require('./local-rpc');
        client = await rpc.connect(ca);
        const response = await client.call(rpc.method('connection', 'ConnectionService', 'Connect'), { useBindlessRpc: true });
        assert.equal(response.useBindlessRpc, true);
        await client.call(rpc.method('authentication', 'AuthenticationService', 'Logon'), { program: 'WoW', platform: 'Win', locale: 'enGB' });
        const challenge = await client.callback(rpc.method('challenge', 'ChallengeListener', 'OnExternalChallenge'));
        const url = challenge.payload.toString();
        // Validate without printing the bearer ticket, even on an assertion failure.
        assert.ok(url.startsWith(WEB_URL) && /^[a-f0-9]{40}$/.test(url.slice(WEB_URL.length)), 'Unexpected challenge URL');
        const form = await request(ca, url);
        assert.equal(form.status, 200);
        assert.ok(form.body.inputs.some(input => input.input_id === 'account_name'));
        const body = password => ({ inputs: [{ input_id: 'account_name', value: identity.email }, { input_id: 'password', value: password }] });
        const wrong = await request(ca, url, body(identity.password + '-wrong'));
        assert.equal(wrong.status, 200); assert.equal(wrong.body.authentication_state, 'LOGIN');
        const correct = await request(ca, url, body(identity.password));
        assert.equal(correct.status, 200); assert.equal(correct.body.authentication_state, 'DONE');
        assert.ok(correct.body.login_ticket === url.slice(WEB_URL.length), 'Unexpected login ticket');
        await client.call(rpc.method('authentication', 'AuthenticationService', 'VerifyWebCredentials'),
            { webCredentials: Buffer.from(correct.body.login_ticket) });
        const result = await client.callback(rpc.method('authentication', 'AuthenticationListener', 'OnLogonComplete'));
        assert.equal(result.errorCode, 0);
        assert.equal(result.accountId.low.toString(), fixture.accountId);
        assert.deepEqual(result.gameAccountId.map(id => id.low.toString()), [fixture.gameAccountId]);
        assert.equal(result.battleTag, 'LocalTest#0001');
        assert.ok(result.sessionKey.length > 0);
        console.log(`Full login passed: account=${fixture.accountId}, gameAccount=${fixture.gameAccountId}, migrations=${fixture.migrations.length}`);
        console.log('Retained test account; retrieve its password with npm run local:credentials');
    }
    finally { client?.close(); await stop(); }
}

async function main() {
    process.chdir(root);
    switch (process.argv[2]) {
        case 'preflight': await preflight(); break;
        case 'credentials': console.log(JSON.stringify(await credentials(), null, 2)); break;
        case 'test': await testLogin(); break;
        case 'forward': {
            await preflight();
            const stop = await forward();
            try { await stop.closed; } finally { await stop(); }
            break;
        }
        default: throw new Error('Usage: node scripts/local.js preflight|forward|credentials|test');
    }
}
if (require.main === module) {
    for (const signal of ['SIGINT', 'SIGTERM']) {
        process.once(signal, () => {
            for (const child of children) { child.kill('SIGTERM'); }
            process.exitCode = signal === 'SIGINT' ? 130 : 143;
        });
    }
    main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
module.exports = { condition };
