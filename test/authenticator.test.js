'use strict';
const assert = require('node:assert/strict');
const { test } = require('node:test');
const { once } = require('node:events');
const { seal, open, codeAt, matchCode, requireProof, Authenticator } = require('../utils/authenticator');
const { RedisStore } = require('../utils/redis-store');
const createRestApp = require('../utils/rest-app');
const secret = Buffer.from('12345678901234567890');
const key = Buffer.from(Array.from({ length: 32 }, (_, index) => index));
const account = { id: '9007199254740993', credentialVersion: '7', authenticatorGeneration: '42', authenticatorState: 2 };
const now = 1111111111;

test('eight-digit RFC 6238 SHA1 vectors and account-bound v2 envelope match the admin contract', () => {
    for (const [time, code] of [[59, '94287082'], [1111111109, '07081804'], [1111111111, '14050471'], [1234567890, '89005924'], [2000000000, '69279037'], [20000000000, '65353130']]) {
        assert.equal(codeAt(secret, Math.floor(time / 30)), code);
    }
    const sealed = seal(secret, key, account.id, '42', Buffer.from('000102030405060708090a0b', 'hex'));
    assert.equal(sealed.toString('hex'), '02000102030405060708090a0b7630e52ff0d3f523b471a6b982dd4d5bb4eebe0480a7581bbea77a53689bb8ead38e3f38');
    assert.deepEqual(open(sealed, key, account.id, '42'), secret);
    for (const [id, generation] of [['9007199254740992', '42'], [account.id, '43']]) {
        assert.throws(() => open(sealed, key, id, generation));
    }
    sealed[48] ^= 1;
    assert.throws(() => open(sealed, key, account.id, '42'));
    assert.equal(matchCode(secret, '14050471', now, Math.floor(now / 30)), null);
    assert.equal(matchCode(secret, '14050471', now + 30, null), Math.floor(now / 30));
    assert.equal(matchCode(secret, '14050471', now + 60, null), null);
});

test('credential resets, enrollment replacement and missing proofs revoke admission', () => {
    const proof = { ...account, authenticatorVerifiedAt: now };
    assert.doesNotThrow(() => requireProof(account, proof, now * 1000));
    for (const changed of [{ credentialVersion: '8' }, { authenticatorGeneration: '43' }]) {
        assert.throws(() => requireProof({ ...account, ...changed }, proof));
    }
    assert.throws(() => requireProof(account, {}));
    assert.throws(() => requireProof(account, proof, now * 1000 - 1));
});

test('verification commits replay and throttle state while holding parent then enrollment locks', async () => {
    let clock = now, locks = [], commits = 0;
    const row = { generation: '42', sealed_secret: seal(secret, key, account.id, '42'), last_step: null, failed_attempts: 0, blocked_until: 0 };
    const models = { Account: { findByPk: async (_id, options) => { assert.equal(options.lock, 'UPDATE'); locks.push('parent'); return account; } },
        sequelize: {
            transaction: async action => { locks = []; const result = await action({ LOCK: { UPDATE: 'UPDATE' } }); commits++; return result; },
            query: async (sql, options) => {
                if (sql.startsWith('SELECT')) { locks.push('enrollment'); assert.deepEqual(locks, ['parent', 'enrollment']); return [row]; }
                const { step, failures, blocked } = options.replacements;
                Object.assign(row, { last_step: step, failed_attempts: failures, blocked_until: blocked });
            }
        } };
    const verifier = new Authenticator(models, key, () => clock * 1000);
    const pending = { ...account, expiresAt: now + 120 };
    for (let attempt = 0; attempt < 5; attempt++) { assert.equal(await verifier.verify(account, pending, '00000000'), null); }
    assert.equal(commits, 5);
    assert.equal(row.blocked_until, now + 30);
    assert.equal(await verifier.verify(account, pending, codeAt(secret, Math.floor(clock / 30))), null);
    clock += 30;
    const code = codeAt(secret, Math.floor(clock / 30));
    assert.equal((await verifier.verify(account, pending, code)).authenticatorVerifiedAt, clock);
    assert.equal(await verifier.verify(account, pending, code), null);
    assert.equal(await verifier.verify(account, { ...pending, credentialVersion: '6' }, code), null);
});

function ticketStore() {
    const ticket = { ticket: 'ticket', program: 'WoW', address: '192.0.2.1' };
    const store = Object.create(RedisStore.prototype);
    store.transaction = async (_keys, action) => {
        const result = await action({ pTTL: async () => 300000, hGet: async (_key, field) => ticket[field] });
        for (const [operation, , ...args] of result.commands) {
            if (operation === 'HDEL') { for (const field of args) { delete ticket[field]; } }
            else if (operation === 'HSET') { for (let index = 0; index < args.length; index += 2) { ticket[args[index]] = args[index + 1]; } }
            else { assert.fail('Unexpected TTL extension'); }
        }
        return result.result;
    };
    store.getLoginTicket = async () => ({ ...ticket });
    return { store, ticket };
}

test('replacing a password challenge invalidates in-flight token completion and single-consumes the winner', async () => {
    const { store, ticket } = ticketStore();
    const first = await store.beginAuthenticator('ticket', account.id, account);
    const second = await store.beginAuthenticator('ticket', account.id, account);
    assert.equal(ticket.accountId, undefined);
    await assert.rejects(store.authorizeLoginTicket('ticket', account.id, account, first.challenge));
    await store.authorizeLoginTicket('ticket', account.id, { ...account, authenticatorVerifiedAt: now }, second.challenge);
    assert.equal(ticket.accountId, account.id);
    assert.equal(ticket.authenticatorPending, undefined);
    await assert.rejects(store.authorizeLoginTicket('ticket', account.id, account, second.challenge));
});

test('REST keeps enrolled password logins pending until a valid native token response', async t => {
    const { store, ticket } = ticketStore();
    const models = { ipBansEnabled: false, Account: { findOne: async () => account, findByPk: async () => account } };
    const app = createRestApp({ models, store, compare: async () => true, logger: { info() {}, error() {} }, isReady: () => true,
        authenticator: { key, verify: async (_account, _pending, code) => code === '12345678' ? { ...account, authenticatorVerifiedAt: now } : null } });
    const server = app.listen(0, '127.0.0.1');
    await once(server, 'listening');
    t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
    const post = async inputs => {
        const response = await fetch(`http://127.0.0.1:${server.address().port}/bnetserver/login/ticket`, {
            method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ inputs }) });
        assert.equal(response.status, 200);
        return response.json();
    };
    const token = value => [{ input_id: 'authenticator_token', value }];
    assert.equal((await post(token('12345678'))).authentication_state, 'LOGIN');
    assert.equal((await post([{ input_id: 'account_name', value: 'fixture' }, { input_id: 'password', value: 'password' }])).authentication_state, 'TOKEN');
    assert.equal(ticket.accountId, undefined);
    assert.equal((await post(token('00000000'))).authentication_state, 'TOKEN');
    assert.equal(ticket.accountId, undefined);
    assert.equal((await post(token('12345678'))).authentication_state, 'DONE');
    assert.equal(ticket.accountId, account.id);
    assert.equal(ticket.authenticatorGeneration, '42');
});
