'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const zlib = require('node:zlib');
const Long = require('long');
const GameUtilitiesService = require('../services/game_utilities');
const { realmFixture, joinTickets, identity } = require('./support/realm-join-fixture');

const GAME = '9007199254740993';
function setup(build = 26972) {
    const f = realmFixture(build);
    f.service = new GameUtilitiesService({ logger: { debug() {}, error() {} }, store: f.redis, models: f.models, realmDirectory: f.realmDirectory });
    return f;
}
const blob = (name, value) => ({ blobValue: Buffer.from(name + ':' + JSON.stringify(value) + '\0') });
const unpack = buffer => JSON.parse(zlib.inflateSync(buffer.subarray(4)).toString().replace(/^[A-Za-z]+:/, '').replace(/\0$/, ''));
async function call(service, attribute) {
    const context = { identity, request: { attribute }, response: {} };
    assert.equal(await service.ProcessClientRequest(context), 0);
    return Object.fromEntries(context.response.attribute.map(a => [a.name, a.value]));
}
const ticketRequest = (f, identityJSON = { gameAccountID: GAME }) => [
    { name: 'Command_RealmListTicketRequest_v1_b9', value: {} },
    { name: 'Param_Identity', value: blob('JSONRealmListTicketIdentity', identityJSON) },
    { name: 'Param_ClientInfo', value: blob('JSONRealmListTicketClientInformation', f.clientInfo()) }
];
const joinRequest = (ticket, version = 'v1') => [
    { name: 'Command_RealmJoinRequest_' + version + '_b9', value: { stringValue: '1-1-0' } },
    { name: 'Param_RealmListTicket', value: ticket },
    { name: 'Param_RealmAddress', value: { uintValue: Long.fromNumber(0x01010001) } }
];

test('Legion ticket, realm list, join and discovery round-trip through the attribute protocol', async () => {
    const f = setup();
    f.state.counts = [{ realm_uid: f.rows[0].realm_uid, character_count: 4 }];
    const { Param_RealmListTicket: ticket } = await call(f.service, ticketRequest(f));
    assert.equal(ticket.blobValue.length, 20);
    const list = await call(f.service, [{ name: 'Command_RealmListRequest_v1_b9', value: { stringValue: '1-1-0' } }, { name: 'Param_RealmListTicket', value: ticket }]);
    const updates = unpack(list.Param_RealmList.blobValue).updates;
    assert.equal(updates[0].update.name, 'Test');
    assert.equal(updates[0].update.wowRealmAddress, 0x01010001);
    assert.deepEqual(unpack(list.Param_CharacterCountList.blobValue).counts, [{ count: 4, wowRealmAddress: 0x01010001 }]);
    const joined = await call(f.service, joinRequest(ticket));
    assert.deepEqual(unpack(joined.Param_ServerAddresses.blobValue), { families: [{ family: 1, addresses: [] }] });
    assert.equal(joined.Param_RealmJoinTicket.blobValue.length, 20);
    assert.equal(joined.Param_JoinSecret.blobValue.length, 32);
    assert.equal(joined.Param_RealmAccountName, undefined);
    assert.equal(joinTickets(f.redis)[0].record.join_secret, joined.Param_JoinSecret.blobValue.toString('hex'));
    const discovery = { identity, request: { attributeKey: 'Command_RealmListRequest_v1_b9' }, response: { attributeValue: [] } };
    assert.equal(await f.service.GetAllValuesForAttribute(discovery), 0);
    assert.deepEqual(discovery.response.attributeValue.map(value => value.stringValue), ['1-1-0']);
    assert.equal(await f.service.GetAllValuesForAttribute({ ...discovery, request: { attributeKey: 'Unknown' } }), 0xBC7);
});

test('Cataclysm v0 join returns the account alias and realm key attributes', async () => {
    const f = setup(15595);
    const { Param_RealmListTicket: ticket } = await call(f.service, ticketRequest(f));
    const joined = await call(f.service, joinRequest(ticket, 'v0'));
    assert.equal(joined.Param_RealmAccountName.stringValue, '1#2');
    assert.equal(joined.Param_RealmSessionKey.blobValue.length, 40);
    assert.equal(joined.Param_RealmJoinTicket.blobValue.length, 20);
    assert.equal(joined.Param_JoinSecret, undefined);
});

test('malformed JSON attribute payloads are rejected before any ticket is written', async () => {
    for (const value of [{ blobValue: Buffer.from('JSONRealmListTicketIdentity:{}') }, { blobValue: Buffer.from('Other:{}\0') },
        { blobValue: Buffer.from('JSONRealmListTicketIdentity:{\0') }, { blobValue: Buffer.from([0xFF, 0]) }]) {
        const f = setup(), attributes = ticketRequest(f);
        attributes[1] = { ...attributes[1], value };
        await assert.rejects(f.service.ProcessClientRequest({ identity, request: { attribute: attributes }, response: {} }), error => error === 0xA);
        assert.equal(f.redis.values.size, 1);
    }
});

test('wire dispatch rejects unsupported versions, duplicate attributes, wrong types and cross-build joins before issuance', async () => {
    const f = setup();
    const { Param_RealmListTicket: ticket } = await call(f.service, ticketRequest(f));
    const attributes = joinRequest(ticket);
    const dispatch = list => f.service.ProcessClientRequest({ identity, request: { attribute: list }, response: {} });
    for (const version of ['v2_b9', 'v1_b8']) {
        await assert.rejects(dispatch([{ ...attributes[0], name: 'Command_RealmJoinRequest_' + version }, ...attributes.slice(1)]), error => error === 0x84D3);
    }
    await assert.rejects(dispatch([{ ...attributes[0], name: 'Command_RealmJoinRequest_v0_b9' }, ...attributes.slice(1)]), error => error === 10);
    for (const list of [[...attributes, attributes[0]], [...attributes, attributes[1]],
        [attributes[0], { ...attributes[1], value: { stringValue: 'not-a-blob' } }, attributes[2]],
        [attributes[0], attributes[1], { ...attributes[2], value: { uintValue: Long.fromString('4294967297') } }],
        [{ ...attributes[0], value: { stringValue: '2-1-0' } }, ...attributes.slice(1)],
        [attributes[0], { ...attributes[1], value: { blobValue: Buffer.alloc(19) } }, attributes[2]]]) {
        await assert.rejects(dispatch(list), error => error === 10);
    }
    assert.equal(joinTickets(f.redis).length, 0);
    assert.equal(await dispatch(attributes), 0);
});

test('command failures keep their realm status codes on the wire', async () => {
    const f = setup();
    const { Param_RealmListTicket: ticket } = await call(f.service, ticketRequest(f));
    f.rows[0].available = 0;
    await assert.rejects(f.service.ProcessClientRequest({ identity, request: { attribute: joinRequest(ticket) }, response: {} }), error => error === 0x80000075);
    await assert.rejects(f.service.ProcessClientRequest({ identity, request: { attribute: joinRequest({ blobValue: Buffer.alloc(20) }) }, response: {} }), error => error === 0x8000012D);
});
