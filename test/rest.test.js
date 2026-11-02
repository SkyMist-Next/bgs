'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { once } = require('node:events');
const createRestApp = require('../utils/rest-app');
const bcrypt = require('bcrypt');
const hash = '$2a$08$abcdefghijklmnopqrstuuyjFh/9WUPhvCkimSGx1o9cH97is4152';
const inputs = [
    { input_id: 'account_name', value: 'demo@example.test' },
    { input_id: 'password', value: 'migration-password' }
];

async function setup(t, { failure, missingAccount = false, missingTicket = false, compare } = {}) {
    const writes = [];
    const errors = [];
    const requests = [];
    let ready = false;
    const models = { IPBan: { findOne: async () => null }, Account: { findOne: async query => {
        assert.equal(query.where.email, 'demo@example.test');
        if (failure === 'mysql') { throw new Error('mysql unavailable'); }
        return missingAccount ? null : { id: '9007199254740993', hash };
    } } };
    const store = {
        getLoginTicket: async () => {
            if (failure === 'read') { throw new Error('Redis unavailable'); }
            return missingTicket ? null : { ticket: 'ticket-value', program: 'WoW' };
        },
        authorizeLoginTicket: async (ticket, value) => {
            if (failure === 'write') { throw new Error('Redis write unavailable'); }
            writes.push({ ticket, value });
        }
    };
    const app = createRestApp({ models, store, logger: { info: (message, fields) => requests.push({ message, ...fields }), error: error => errors.push(error) }, isReady: () => ready, compare });
    const server = app.listen(0, '127.0.0.1');
    await once(server, 'listening');
    t.after(() => new Promise((resolve, reject) => {
        server.close(error => error ? reject(error) : resolve());
        server.closeAllConnections();
    }));
    const url = `http://127.0.0.1:${server.address().port}`;
    return {
        url, writes, errors, requests, setReady: value => { ready = value; },
        post: (body = { inputs }, type = 'application/json') => fetch(url + '/bnetserver/login/ticket', {
            method: 'POST', headers: { 'content-type': type }, body: typeof body === 'string' ? body : JSON.stringify(body)
        })
    };
}

test('alive, ready, and login form retain their response contracts', async t => {
    const app = await setup(t);
    assert.equal((await fetch(app.url + '/alive')).status, 200);
    assert.equal((await fetch(app.url + '/ready')).status, 500);
    app.setReady(true);
    assert.equal((await fetch(app.url + '/ready')).status, 200);
    const form = await (await fetch(app.url + '/bnetserver/login/ticket')).json();
    assert.equal(form.type, 'LOGIN_FORM');
    assert.deepEqual(form.inputs.map(input => input.input_id), ['account_name', 'password', 'log_in_submit']);
});

test('request logs redact tickets, queries and bodies including parser failures and unknown routes', async t => {
    const app = await setup(t);
    await fetch(app.url + '/bnetserver/login/secret-ticket?password=secret-query');
    await app.post();
    await app.post('{"password":"secret-body",');
    await fetch(app.url + '/secret-path?token=secret-query');
    assert.equal(app.requests.length, 4);
    assert.deepEqual(app.requests.map(row => row.status), [200, 200, 400, 404]);
    assert.deepEqual(app.requests.map(row => row.route), [
        '/bnetserver/login/:loginTicket', '/bnetserver/login/:loginTicket', 'unmatched', 'unmatched'
    ]);
    for (const row of app.requests) {
        assert.equal(row.message, 'REST request');
        assert.equal(row.address, '127.0.0.1');
        assert.equal(row.aborted, false);
        assert.ok(row.durationMs >= 0);
    }
    assert.doesNotMatch(JSON.stringify(app.requests), /secret-|demo@example|migration-password/);
});

test('legacy bcrypt hash authenticates and publishes the full account ID', async t => {
    const app = await setup(t);
    const response = await app.post();
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { login_ticket: 'ticket-value', authentication_state: 'DONE' });
    assert.deepEqual(app.writes, [{ ticket: 'ticket', value: '9007199254740993' }]);
    assert.equal(await bcrypt.compare('migration-password', hash.replace('$2a$', '$2b$')), true);
});

test('URL-encoded login retains support for nested inputs', async t => {
    const app = await setup(t);
    const body = new URLSearchParams();
    inputs.forEach((input, i) => Object.entries(input).forEach(([key, value]) => body.set(`inputs[${i}][${key}]`, value)));
    const response = await app.post(body.toString(), 'application/x-www-form-urlencoded');
    assert.equal((await response.json()).authentication_state, 'DONE');
});

test('invalid credentials and missing accounts return LOGIN without writing a ticket', async t => {
    for (const missingAccount of [false, true]) {
        const app = await setup(t, { missingAccount });
        const response = await app.post({ inputs: [inputs[0], { input_id: 'password', value: 'incorrect' }] });
        assert.equal(response.status, 200);
        assert.deepEqual(await response.json(), { authentication_state: 'LOGIN' });
        assert.equal(app.writes.length, 0);
    }
});

test('malformed JSON, missing bodies, invalid fields, and duplicate credentials return 400', async t => {
    const app = await setup(t);
    for (const body of ['', '{', 'null', {}, { inputs: null }, { inputs: {} }, { inputs: [null] },
        { inputs: [{ input_id: 'account_name', value: 42 }, inputs[1]] },
        { inputs: [inputs[0], { input_id: 'password', value: {} }] }, { inputs: [inputs[0]] },
        { inputs: [...inputs, inputs[0]] }, { inputs: [inputs[0], { input_id: 'password', value: '' }] }]) {
        assert.equal((await app.post(body)).status, 400, JSON.stringify(body));
    }
    assert.equal((await app.post('plain', 'text/plain')).status, 400);
    assert.equal((await fetch(app.url + '/bnetserver/login/%ZZ')).status, 400);
    assert.equal(app.writes.length, 0);
});

test('dependency rejections return 500 without leaking details or writing success', async t => {
    for (const failure of ['read', 'mysql', 'write', 'bcrypt']) {
        const app = await setup(t, { failure, compare: failure === 'bcrypt' ? async () => { throw new Error('bcrypt failure'); } : undefined });
        const response = await app.post();
        assert.equal(response.status, 500);
        assert.equal(await response.text(), 'Internal Server Error');
        assert.equal(app.errors.length, 1);
        assert.equal(app.writes.length, 0);
    }
    const app = await setup(t, { missingTicket: true });
    assert.equal((await app.post()).status, 500);
    assert.equal(app.writes.length, 0);
});

test('pending asynchronous password checks do not block health requests or other logins', async t => {
    const pending = [];
    let allStarted;
    const started = new Promise(resolve => { allStarted = resolve; });
    const app = await setup(t, { compare: () => new Promise(resolve => {
        pending.push(resolve);
        if (pending.length === 4) { allStarted(); }
    }) });
    const requests = Array.from({ length: 4 }, () => app.post());
    await started;
    assert.equal((await fetch(app.url + '/alive')).status, 200);
    pending.forEach(resolve => resolve(true));
    const responses = await Promise.all(requests);
    for (const response of responses) {
        assert.equal((await response.json()).authentication_state, 'DONE');
    }
    assert.equal(app.writes.length, 4);
});


test('optional submit inputs without a value remain compatible with the login form', async t => {
    const app = await setup(t);
    const response = await app.post({ inputs: [...inputs, { input_id: 'log_in_submit' }] });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).authentication_state, 'DONE');
});

test('HTTPS wire headers retain Legion Content-Type casing and health can be internal-only', async t => {
    const https = require('node:https');
    const fs = require('node:fs');
    const dir = fs.mkdtempSync(require('node:path').join(require('node:os').tmpdir(), 'bgs-https-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    require('node:child_process').execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=localhost', '-addext', 'subjectAltName=DNS:localhost', '-keyout', dir + '/key', '-out', dir + '/cert'], { stdio: 'ignore' });
    const cert = fs.readFileSync(dir + '/cert');
    const app = createRestApp({ models: {}, store: {}, logger: { info() {}, error() {} },
        isReady: () => true, exposeHealth: false });
    const server = https.createServer({ cert, key: fs.readFileSync(dir + '/key') }, app).listen(0, '127.0.0.1');
    await once(server, 'listening');
    t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
    const request = route => new Promise((resolve, reject) => {
        https.get({ host: '127.0.0.1', servername: 'localhost', ca: cert, port: server.address().port, path: route }, res => {
            res.resume(); res.on('end', () => resolve(res));
        }).on('error', reject);
    });
    const response = await request('/bnetserver/login/test');
    assert.equal(response.rawHeaders[response.rawHeaders.indexOf('Content-Type') + 1], 'application/json; charset=utf-8');
    for (const route of ['alive', 'ready']) {
        assert.equal((await request('/' + route)).statusCode, 404);
    }
});
