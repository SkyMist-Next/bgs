'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { WorldSessionLeases, readLease, leaseKey, sameClaimant, sameWorld } = require('../realm/sessions');

const lease = Object.freeze({ version: 1, account_id: '9007199254740993', game_account_id: '9007199254740995',
    session_id: 'cccccccc-0000-4000-8000-000000000001', generation: '7', namespace: 'local',
    realm_uid: 'cccccccc-0000-4000-8000-000000000002', pod_uid: 'cccccccc-0000-4000-8000-000000000003',
    instance_id: 'cccccccc-0000-4000-8000-000000000004', build: 26972, expansion: 6, address: '127.0.0.1' });

function fixture({ raw = JSON.stringify(lease), process = { instance_id: lease.instance_id }, models = true } = {}) {
    const reads = [], lookups = [];
    const client = { get: async key => { reads.push(key); return key === leaseKey(lease.game_account_id) ? raw : null; } };
    const store = { run: action => action(client) };
    const model = { RealmProcessOwner: { findByPk: async (uid, options) => { lookups.push([uid, options]); return process; } } };
    return { reads, lookups, client, leases: new WorldSessionLeases(store, models ? model : undefined) };
}

test('a missing lease reads as null and is not live', async () => {
    const f = fixture({ raw: null });
    assert.equal(await f.leases.read(lease.game_account_id), null);
    assert.equal(await f.leases.live(lease.game_account_id), null);
    assert.equal(await readLease(f.client, lease.game_account_id), null);
    assert.deepEqual(f.lookups, []);
});

test('a valid lease owned by its realm process is live', async () => {
    const f = fixture();
    assert.deepEqual(await f.leases.read(lease.game_account_id), lease);
    assert.deepEqual(await f.leases.live(lease.game_account_id, { expected: lease, transaction: 'tx' }), lease);
    assert.deepEqual(f.lookups, [[lease.realm_uid, { transaction: 'tx', raw: true }]]);
});

test('malformed leases make strict reads throw and are never live', async () => {
    for (const raw of ['{', JSON.stringify({ ...lease, version: 2 }), JSON.stringify({ ...lease, realm_uid: 'realm' }),
        JSON.stringify({ ...lease, address: '127.000.0.1' }), JSON.stringify({ ...lease, generation: 7 }),
        JSON.stringify({ ...lease, authenticator_verified_at: -1 })]) {
        const f = fixture({ raw });
        await assert.rejects(f.leases.read(lease.game_account_id));
        assert.equal(await f.leases.live(lease.game_account_id), null);
        assert.deepEqual(f.lookups, []);
    }
});

test('invalid game account ids are rejected before Redis is touched', async () => {
    for (const value of ['0', '01', '-1', 'x', 1, '9223372036854775808', '1/../2']) {
        const f = fixture();
        await assert.rejects(f.leases.read(value), { code: 'INVALID_ID' });
        await assert.rejects(f.leases.live(value), { code: 'INVALID_ID' });
        assert.deepEqual(f.reads, []);
    }
});

test('a lease for a different world incarnation is not live', async () => {
    for (const field of ['session_id', 'realm_uid', 'pod_uid', 'instance_id']) {
        const expected = { ...lease, [field]: 'dddddddd-0000-4000-8000-000000000009' };
        assert.equal(await fixture().leases.live(lease.game_account_id, { expected }), null);
    }
    assert.equal(await fixture().leases.live(lease.game_account_id, { expected: { ...lease, generation: '8' } }), null);
});

test('the realm process owner fences liveness when models are supplied', async () => {
    assert.equal(await fixture({ process: null }).leases.live(lease.game_account_id), null);
    assert.equal(await fixture({ process: { instance_id: 'cccccccc-0000-4000-8000-0000000000ff' } }).leases.live(lease.game_account_id), null);
    const f = fixture({ process: null, models: false });
    assert.deepEqual(await f.leases.live(lease.game_account_id), lease);
    assert.deepEqual(f.lookups, []);
});

test('claimant and world identity compare different fields', () => {
    // A renewed generation is the same claimant but a new world incarnation.
    assert.equal(sameClaimant({ ...lease, generation: '8' }, lease), true);
    assert.equal(sameWorld({ ...lease, generation: '8' }, lease), false);
    // Build, expansion, address and proof identify the claimant, not the world incarnation.
    for (const change of [{ build: 15595 }, { expansion: 3 }, { address: '127.0.0.2' }, { credential_version: '2' }]) {
        assert.equal(sameClaimant({ ...lease, ...change }, lease), false);
        assert.equal(sameWorld({ ...lease, ...change }, lease), true);
    }
    assert.equal(sameWorld({ ...lease, account_id: '9007199254740997' }, lease), false);
});
