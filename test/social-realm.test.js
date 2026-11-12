'use strict';
const assert = require('node:assert/strict');
const { test } = require('node:test');
const SocialRealm = require('../social/realm');
const { Failure } = require('../realm/contract');
const wire = require('../social/wire');
const Header = wire.type('rpc_types', 'bgs.protocol.Header');
function setup() {
    const realm = { namespace: 'local', realm_uid: 'realm', pod_uid: 'pod', instance_id: 'process' };
    const owner = { ...realm, account_id: '9007199254740993', game_account_id: '9007199254740995',
        session_id: 'session', generation: '17', build: 26972 };
    const request = { version: 1, request_id: 'request', operation: 'social.call', realm,
        game_account_id: owner.game_account_id, session_id: owner.session_id, generation: owner.generation,
        deadline: new Date(Date.now() + 5000).toISOString(), arguments: {
            service_hash: 0x53C8C253, method_id: 1, object_id: '18446744073709551615', payload: Buffer.from('request').toString('base64') } };
    const events = [], state = { raw: JSON.stringify(owner) };
    const services = new Map([[0x53C8C253, {
        getServiceHash: () => 0x0CBE3C43,
        handleCall: async (context, payload) => {
            events.push(['call', context, payload]);
            context.afterReply = async () => events.push(['subscribed']);
            const header = Header.encode(Header.fromObject({ ...context.header, status: 0x1B58, serviceId: 254, size: 5 })).finish();
            const size = Buffer.alloc(2); size.writeUInt16BE(header.length);
            return Buffer.concat([size, header, Buffer.from('reply')]);
        }
    }]]);
    const runtime = { refreshWorldRoute: async (lease, queue) => events.push(['route', lease, queue]), worldContext: (context, lease, queue) => events.push(['context', context, lease, queue]) };
    const store = { run: action => action({ get: async () => state.raw }) };
    const service = new SocialRealm({ store }, runtime, services, { publish: async (...args) => { events.push(['publish', ...args]); return { sequence: '18' }; } });
    service.authority.authorize = async () => events.push(['authorized']);
    return { service, owner, state, request, events, services };
}
test('world bridge preserves object/payload/status, translates hashes and defers subscribe activation until reply', async () => {
    const f = setup(); const result = await f.service.execute(f.request, { replyTo: 'private-world-queue', headers: { social_route_epoch: '1' } });
    assert.deepEqual(result, { version: 1, request_id: 'request', status: 'success', result: { status: 0x1B58, payload: Buffer.from('reply').toString('base64') } });
    const call = f.events.find(event => event[0] === 'call');
    assert.equal(call[1].header.serviceHash, 0x0CBE3C43); assert.equal(call[1].header.objectId, '18446744073709551615');
    assert.equal(call[2].toString(), 'request');
    assert.equal(f.events.some(event => event[0] === 'subscribed'), false);
    assert.equal(JSON.stringify(result).includes('afterReply'), false);
    await result.afterReply(); assert.equal(f.events.at(-1)[0], 'subscribed');
});
test('social calls fail closed on expiry, replaced leases, wrong build and custom legacy services', async () => {
    for (const [change, code] of [
        [f => { f.request.deadline = new Date(0).toISOString(); }, 'DEADLINE_EXPIRED'],
        [f => { f.request.generation = '0'; }, 'SESSION_NOT_OPEN'],
        [f => { f.state.raw = null; }, 'SESSION_OWNERSHIP_LOST'],
        [f => { f.state.raw = JSON.stringify({ ...f.owner, generation: '18' }); }, 'STALE_SESSION'],
        [f => { f.state.raw = JSON.stringify({ ...f.owner, build: 15595 }); }, 'UNSUPPORTED_BUILD'],
        [f => { f.services.get(0x53C8C253).legacyOnly = true; }, 'UNSUPPORTED_SOCIAL_SERVICE'],
        [f => { f.request.arguments.service_hash = 123; }, 'UNSUPPORTED_SOCIAL_SERVICE']
    ]) {
        const f = setup(); change(f);
        await assert.rejects(f.service.execute(f.request, { replyTo: 'world', headers: { social_route_epoch: '1' } }), { code });
        assert.equal(f.events.some(event => event[0] === 'call'), false);
    }
});
test('character publication uses the authorized lease and a dependency outage stays a social rejection', async () => {
    const f = setup(); f.request.operation = 'social.presence'; f.request.arguments = { sequence: '18', active: false, character: null };
    assert.equal((await f.service.execute(f.request, { replyTo: 'world', headers: { social_route_epoch: '1' } })).result.sequence, '18');
    const published = f.events.find(event => event[0] === 'publish'); assert.deepEqual(published[1], { ...f.owner, routeEpoch: '1' });
    f.service.authority.authorize = async () => { throw new Error('database unavailable'); };
    await assert.rejects(f.service.execute(f.request, { replyTo: 'world', headers: { social_route_epoch: '1' } }), error => error instanceof Failure && error.code === 'SOCIAL_UNAVAILABLE' && error.retryable);
});

test('world routes require canonical epochs, reject stale queues, and bound full snapshot replies to one MiB', async () => {
    for (const epoch of [undefined, 1, '0', '01', '-1', '18446744073709551616']) {
        const f = setup();
        await assert.rejects(f.service.execute(f.request, { replyTo: 'world', headers: { social_route_epoch: epoch } }), { code: 'INVALID_SOCIAL_ROUTE' });
        assert.equal(f.events.some(event => event[0] === 'call'), false);
    }
    const f = setup(), properties = { replyTo: 'world', headers: { social_route_epoch: '18446744073709551615' } };
    f.service.runtime.refreshWorldRoute = async () => { throw 0xA; };
    await assert.rejects(f.service.execute(f.request, properties), { code: 'STALE_SOCIAL_ROUTE' });
    assert.equal(f.events.some(event => event[0] === 'call'), false);
    f.service.runtime.refreshWorldRoute = async () => {};
    for (const bytes of [1048576, 1048577]) {
        f.services.get(0x53C8C253).handleCall = async context => {
            const header = Header.encode(Header.fromObject({ ...context.header, status: 0, serviceId: 254, size: bytes })).finish();
            const size = Buffer.alloc(2); size.writeUInt16BE(header.length);
            return Buffer.concat([size, header, Buffer.alloc(bytes)]);
        };
        if (bytes === 1048576) {
            const result = await f.service.execute(f.request, properties);
            assert.equal(Buffer.from(result.result.payload, 'base64').length, bytes);
        } else { await assert.rejects(f.service.execute(f.request, properties), { code: 'SOCIAL_PAYLOAD_TOO_LARGE' }); }
    }
});
