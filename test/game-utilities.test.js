'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const zlib = require('node:zlib');
const Long = require('long');
const GameUtilitiesService = require('../services/game_utilities');

function setup() {
    const logger = { debug() {}, error() {} };
    const tickets = new Map();
    const metadata = {
        '/aurora/services/WoWService/subRegions/1-1-0/virtualRealms/1-1-1': {
            update: { name: 'Test', version: { versionMajor: 7, versionMinor: 3, versionRevision: 5 } },
            isHidden: true, isTournament: false, deleting: false, gameServerId: 'server'
        },
        '/aurora/services/WoWService/subRegions/1-1-0/gameServers/server': { endpoints: [{ family: 1, addresses: [] }] }
    };
    const store = {
        setJSON: async (key, value) => tickets.set(key, structuredClone(value)),
        getJSON: async key => {
            if (!tickets.has(key)) { throw new Error('Missing ticket'); }
            return structuredClone(tickets.get(key));
        },
        getMetadataJSON: async key => {
            if (!metadata[key]) { throw new Error('Missing metadata'); }
            return structuredClone(metadata[key]);
        },
        listMetadataJSON: async prefix => Object.fromEntries(Object.entries(metadata).filter(([key]) => key.startsWith(prefix))),
        listMetadata: async () => metadata
    };
    return { service: new GameUtilitiesService({ logger, store }), tickets, store };
}
const blob = (name, value) => ({ blobValue: Buffer.from(name + ':' + JSON.stringify(value) + '\0') });
const unpack = buffer => zlib.inflateSync(buffer.subarray(4)).toString();

async function ticket(service) {
    return service.commandHandlers.RealmListTicketRequest({
        Identity: blob('JSONRealmListTicketIdentity', { gameAccountId: '9007199254740993' }),
        ClientInfo: blob('JSONRealmListTicketClientInformation', { info: {
            version: { versionMajor: 7, versionMinor: 3, versionRevision: 5 }, secret: [1, 2, 3]
        } })
    });
}

test('realm ticket, discovery, and join preserve payloads and identity using the Redis boundary', async () => {
    const { service, tickets } = setup();
    const params = await ticket(service);
    const list = await service.commandHandlers.RealmListRequest(params, { stringValue: '1-1-0' });
    assert.match(unpack(list.RealmList.blobValue), /"name":"Test"/);
    assert.match(unpack(list.RealmList.blobValue), /"flags":2/);
    const response = await service.commandHandlers.RealmJoinRequest({ ...params, RealmAddress: { uintValue: Long.fromNumber(0x01010001) } }, { stringValue: '1-1-0' });
    assert.match(unpack(response.ServerAddresses.blobValue), /"family":1/);
    assert.equal(response.RealmJoinTicket.blobValue.length, 20);
    assert.equal(response.JoinSecret.blobValue.length, 32);
    const stored = [...tickets.values()].find(value => value.joinSecret);
    assert.equal(stored.gameAccount.gameAccountId, '9007199254740993');
    assert.deepEqual(stored.clientSecret, [1, 2, 3]);
    const context = { request: { attributeKey: 'Command_RealmListRequest_v1_b9' }, response: { attributeValue: [] } };
    assert.equal(await service.GetAllValuesForAttribute(context), 0);
    assert.deepEqual(context.response.attributeValue.map(value => value.stringValue), ['1-1-0']);
});

test('realm ticket creation and join failures retain the existing RPC status', async () => {
    const { service, store } = setup();
    store.setJSON = async () => { throw new Error('Redis unavailable'); };
    await assert.rejects(ticket(service), error => error === 0x80000076);
    store.getMetadataJSON = async () => { throw new Error('Missing realm'); };
    await assert.rejects(service.commandHandlers.RealmJoinRequest({ RealmListTicket: { blobValue: Buffer.from('unknown') },
        RealmAddress: { uintValue: Long.fromNumber(0x01010001) } }, { stringValue: '1-1-0' }), error => error === 0x80000075);
});
