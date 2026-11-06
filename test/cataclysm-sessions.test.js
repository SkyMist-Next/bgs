'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { CataclysmSessions, pendingKey, validateTicket, worldProof } = require('../realm/cataclysm-sessions');
const { Sessions, ticketKey, leaseKey } = require('../realm/sessions');
const { realmAccountName, parseRealmAccountName, allocate } = require('../utils/wow-license');
const uid = '11111111-1111-4111-8111-111111111111';
const ticket = 'ab'.repeat(20);
function fixture() {
    let now = 1000;
    const data = new Map(), expiries = new Map(), commands = [];
    const client = { get: async key => data.get(key) ?? null };
    const store = { run: operation => operation(client), transaction: async (keys, decide) => {
        const result = await decide(client);
        for (const [op, key, value, mode, ttl] of result.commands) {
            commands.push([op, key, value, mode, ttl]);
            if (op === 'SET') { data.set(key, value); expiries.set(key, mode === 'PXAT' ? Number(ttl) : now + Number(ttl) * 1000); }
            else if (op === 'DEL') { data.delete(key); expiries.delete(key); }
        }
        return result.result;
    } };
    const record = { version: 1, auth_protocol: 'wow-15595-v0', namespace: 'test', realm_uid: uid,
        game_account_id: '9007199254740993', account_id: '9223372036854775807', expansion: 3, build: 15595,
        region: 1, address: '::1', locale: 'enUS', platform: 'Wn64', gm_level: 0, wow_license_index: 4294967295,
        realm_account_name: '9223372036854775807#4294967295', realm_key: '01'.repeat(40), issued_at_ms: now, expires_at_ms: now + 60000 };
    const proposed = { version: 1, namespace: 'test', realm_uid: uid, pod_uid: uid, instance_id: uid,
        game_account_id: record.game_account_id, account_id: record.account_id, session_id: uid, generation: '0', build: 15595, expansion: 3, address: '127.0.0.1' };
    return { data, expiries, commands, store, record, proposed, setTime: value => { now = value; }, sessions: new CataclysmSessions(store, () => now) };
}
test('native names preserve exact BIGINT identity and reject ambiguous encodings', () => {
    assert.equal(realmAccountName('9223372036854775807', 4294967295).length, 30);
    assert.deepEqual(parseRealmAccountName('42#2'), { accountId: '42', wowLicenseIndex: 2 });
    for (const value of ['0#1', '01#1', '1#01', '+1#1', '1#0', '1#4294967296', '9223372036854775808#1', '1#1\0', '1#1 ', '1#1#1', '１#1']) {
        assert.throws(() => parseRealmAccountName(value));
    }
    assert.throws(() => realmAccountName(Number('9007199254740993'), 1));
});
test('model allocator holds the parent row lock and fails without a transaction or on exhaustion', async () => {
    const transaction = { LOCK: { UPDATE: 'UPDATE' } }, parent = { wowLicenseIndexHighWater: 8, update: async function(values, options) {
        assert.equal(options.transaction, transaction); this.wowLicenseIndexHighWater = values.wowLicenseIndexHighWater;
    } };
    const models = { Account: { findByPk: async (id, options) => { assert.equal(id, '9007199254740993'); assert.equal(options.lock, 'UPDATE'); return parent; } } };
    assert.equal(await allocate(models, '9007199254740993', transaction), 9);
    await assert.rejects(allocate(models, '9007199254740993'));
    parent.wowLicenseIndexHighWater = 4294967295;
    await assert.rejects(allocate(models, '9007199254740993', transaction));
});
test('v0 issuance atomically supersedes pending tickets and preserves matching expiry', async () => {
    const f = fixture(), next = 'cd'.repeat(20);
    await f.sessions.issue(ticket, f.record);
    assert.equal(f.expiries.get(ticketKey(uid, ticket)), 61000);
    assert.equal(f.expiries.get(pendingKey(uid, f.record.realm_account_name)), 61000);
    await f.sessions.issue(next, f.record);
    assert.equal(f.data.has(ticketKey(uid, ticket)), false);
    assert.equal(f.data.get(pendingKey(uid, f.record.realm_account_name)), next);
    const before = [...f.data];
    await assert.rejects(f.sessions.issue(next, f.record), /TICKET_COLLISION/);
    assert.deepEqual([...f.data], before);
});
test('bad proofs consume nothing; exact claims recover a bound generation without extending TTL', async () => {
    const f = fixture();
    await f.sessions.issue(ticket, f.record);
    const observed = f.data.get(ticketKey(uid, ticket)), proof = worldProof(f.record.realm_account_name, Buffer.from(f.record.realm_key, 'hex'), 7, 11);
    await assert.rejects(f.sessions.claim(ticket, observed, f.proposed, Buffer.alloc(20), 7, 11), /INVALID_15595_PROOF/);
    assert(f.data.has(ticketKey(uid, ticket)));
    await f.sessions.claim(ticket, observed, f.proposed, proof, 7, 11);
    assert.equal(f.data.has(ticketKey(uid, ticket)), false);
    assert.equal(f.data.has(pendingKey(uid, f.record.realm_account_name)), false);
    const bound = { ...f.proposed, generation: '9' };
    f.data.set(leaseKey(f.proposed.game_account_id), JSON.stringify(bound));
    const before = f.commands.length;
    f.setTime(62000);
    assert.deepEqual(await f.sessions.claim(ticket, observed, f.proposed, proof, 7, 11), bound);
    assert.equal(f.commands.length, before);
    await assert.rejects(f.sessions.claim(ticket, observed, { ...f.proposed, session_id: '22222222-2222-4222-8222-222222222222' }, proof, 7, 11), /SESSION_ALREADY_ACTIVE/);
});
test('superseded, expired and cross-protocol tickets cannot claim a session', async () => {
    const f = fixture();
    await f.sessions.issue(ticket, f.record);
    const observed = JSON.stringify(f.record), proof = worldProof(f.record.realm_account_name, Buffer.from(f.record.realm_key, 'hex'), 7, 11);
    await f.sessions.issue('cd'.repeat(20), f.record);
    await assert.rejects(f.sessions.claim(ticket, observed, f.proposed, proof, 7, 11), /TICKET_UNAVAILABLE/);
    assert.equal(f.data.get(pendingKey(uid, f.record.realm_account_name)), 'cd'.repeat(20));
    f.setTime(61000);
    await assert.rejects(f.sessions.claim('cd'.repeat(20), observed, f.proposed, proof, 7, 11), /TICKET_EXPIRED/);
    await assert.rejects(new Sessions(f.store).claim(ticket, observed, f.proposed), /INVALID_TICKET/);
    for (const change of [{ auth_protocol: undefined }, { realm_key: '11'.repeat(32) }, { build: 26972 }, { expansion: 6 },
        { wow_license_index: 1 }, { join_secret: '11'.repeat(32) }, { expires_at_ms: 60000 }, { account_id: 1 }]) {
        assert.throws(() => validateTicket({ ...f.record, ...change }));
    }
});
test('ticket collision discovered after WATCH never publishes a partial pending index', async () => {
    const f = fixture(), transaction = f.store.transaction;
    f.store.transaction = async (keys, decide) => {
        f.data.set(ticketKey(uid, ticket), 'another-record');
        return transaction(keys, decide);
    };
    await assert.rejects(f.sessions.issue(ticket, f.record), /TICKET_COLLISION/);
    assert.equal(f.data.has(pendingKey(uid, f.record.realm_account_name)), false);
});
