'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const WorldPresence = require('../social/world-presence');
const { validatePresence, validateCall } = require('../social/realm-contract');

const owner = { account_id: '9007199254740993', game_account_id: '9007199254740995', session_id: 'session-a',
    generation: '7', namespace: 'local', realm_uid: 'realm-a', pod_uid: 'pod-a', instance_id: 'instance-a' };
const character = { guid: '340282366920938463463374607431768211455', name: 'Aster', realm_address: 50397185,
    realm_name: 'Local', level: 85, class: 8, race: 1, zone: 1519, faction: 0 };
function fixture() {
    const rows = new Map([['/skymist/v1/sessions/' + owner.game_account_id, JSON.stringify(owner)]]);
    const client = { get: async key => rows.get(key) || null, mGet: async keys => keys.map(key => rows.get(key) || null) };
    const store = { run: action => action(client), transaction: async (keys, action) => {
        assert.equal(keys.length, 2);
        const value = await action(client);
        for (const command of value.commands) {
            assert.equal(command[0], 'SET'); assert.deepEqual(command.slice(-2), ['EX', '90']);
            rows.set(command[1], command[2]);
        }
        return value.result;
    } };
    return { rows, presence: new WorldPresence(store) };
}
test('authoritative character preserves full-width IDs and publication is idempotent', async () => {
    const { presence } = fixture(), args = { sequence: '1', active: true, character };
    assert.deepEqual(await presence.publish(owner, args), { sequence: '1' });
    assert.deepEqual(await presence.publish(owner, args), { sequence: '1' });
    const value = await presence.get(owner.game_account_id);
    assert.equal(value.owner.account_id, owner.account_id);
    assert.equal(value.character.guid, character.guid);
});
test('withdrawal tombstone rejects late and conflicting character updates', async () => {
    const { presence } = fixture();
    await presence.publish(owner, { sequence: '1', active: true, character });
    await presence.publish(owner, { sequence: '2', active: false, character: null });
    await assert.rejects(presence.publish(owner, { sequence: '1', active: true, character }), { code: 'STALE_PRESENCE' });
    await assert.rejects(presence.publish(owner, { sequence: '2', active: true, character }), { code: 'STALE_PRESENCE' });
    assert.equal((await presence.get(owner.game_account_id)).character, null);
});
test('replacement session fences old publisher and starts its own sequence', async () => {
    const { presence, rows } = fixture();
    await presence.publish(owner, { sequence: '800', active: true, character });
    const replacement = { ...owner, session_id: 'session-b', generation: '8', instance_id: 'instance-b' };
    rows.set('/skymist/v1/sessions/' + owner.game_account_id, JSON.stringify(replacement));
    assert.equal(await presence.get(owner.game_account_id), null);
    await assert.rejects(presence.publish(owner, { sequence: '801', active: true, character }), { code: 'SESSION_OWNERSHIP_LOST' });
    await presence.publish(replacement, { sequence: '1', active: true, character: { ...character, name: 'Beryl' } });
    assert.equal((await presence.get(owner.game_account_id)).character.name, 'Beryl');
});
test('expired gameplay lease removes visibility even while cached presence remains', async () => {
    const { presence, rows } = fixture();
    await presence.publish(owner, { sequence: '1', active: true, character });
    rows.delete('/skymist/v1/sessions/' + owner.game_account_id);
    assert.equal(await presence.get(owner.game_account_id), null);
});
test('bridge rejects unknown fields, invalid character identity and malformed RPC envelopes', () => {
    for (const value of [
        { sequence: '01', active: true, character },
        { sequence: '1', active: false, character },
        { sequence: '1', active: true, character: { ...character, guid: '340282366920938463463374607431768211456' } },
        { sequence: '1', active: true, character: { ...character, account_id: '7' } }
    ]) { assert.throws(() => validatePresence(value), { code: 'INVALID_ARGUMENTS' }); }
    const call = { service_hash: 0x53C8C253, method_id: 1, object_id: '18446744073709551615', payload: 'CAI=' };
    validateCall(call);
    validatePresence({ sequence: '1', active: true, character: { ...character, faction: 2 } });
    validateCall({ ...call, payload: Buffer.alloc(65536).toString('base64') });
    assert.throws(() => validateCall({ ...call, payload: Buffer.alloc(65537).toString('base64') }), { code: 'INVALID_ARGUMENTS' });
    for (const update of [{ payload: 'CAI=\n' }, { object_id: 1 }, { payload: 'CAJ=' }, { service_hash: -1 }]) {
        assert.throws(() => validateCall({ ...call, ...update }), { code: 'INVALID_ARGUMENTS' });
    }
});
