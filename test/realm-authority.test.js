'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const RealmService = require('../realm/service');
const { leaseKey } = require('../realm/sessions');

const lease = Object.freeze({ version: 1, account_id: '9007199254740993', game_account_id: '9007199254740995',
    session_id: 'eeeeeeee-0000-4000-8000-000000000001', generation: '7', namespace: 'local',
    realm_uid: 'eeeeeeee-0000-4000-8000-000000000002', pod_uid: 'eeeeeeee-0000-4000-8000-000000000003',
    instance_id: 'eeeeeeee-0000-4000-8000-000000000004', build: 26972, expansion: 6, address: '127.0.0.1' });
const realm = { namespace: lease.namespace, realm_uid: lease.realm_uid, pod_uid: lease.pod_uid, instance_id: lease.instance_id };

function fixture(raw = JSON.stringify(lease)) {
    const reads = [];
    const store = { run: action => action({ get: async key => { reads.push(key); return key === leaseKey(lease.game_account_id) ? raw : null; } }) };
    // Lease fencing must reject before any SQL is consulted.
    const models = new Proxy({}, { get: (_, name) => { throw new Error('unexpected SQL access to ' + String(name)); } });
    const request = { operation: 'social.call', game_account_id: lease.game_account_id, session_id: lease.session_id,
        generation: lease.generation, realm: { ...realm } };
    return { reads, request, service: new RealmService({ models, store, realmDirectory: null }) };
}

test('realm authority fences requests to the current world session lease', async () => {
    for (const [change, code] of [
        [f => { f.raw = null; }, 'SESSION_OWNERSHIP_LOST'],
        [f => { f.raw = '{'; }, 'INVALID_SESSION'],
        [f => { f.raw = JSON.stringify({ ...lease, realm_uid: 'realm' }); }, 'INVALID_SESSION'],
        [f => { f.request.session_id = 'eeeeeeee-0000-4000-8000-000000000009'; }, 'SESSION_OWNERSHIP_LOST'],
        [f => { f.request.realm.instance_id = 'eeeeeeee-0000-4000-8000-000000000009'; }, 'SESSION_OWNERSHIP_LOST'],
        [f => { f.request.generation = '6'; }, 'STALE_SESSION']
    ]) {
        const state = { raw: JSON.stringify(lease), request: fixture().request };
        change(state);
        const f = fixture(state.raw);
        await assert.rejects(f.service.authorizeSession(state.request), { code });
        await assert.rejects(f.service.authorize(state.request), { code });
    }
});

test('realm authority validates the game account id before reading a lease', async () => {
    const f = fixture();
    await assert.rejects(f.service.authorizeSession({ ...f.request, game_account_id: '1/../2' }), { code: 'INVALID_ID' });
    assert.deepEqual(f.reads, []);
});
