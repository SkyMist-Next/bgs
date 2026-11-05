'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const zlib = require('node:zlib');
const Long = require('long');
const GameUtilitiesService = require('../services/game_utilities');

const identity = { connectionId: 'test-connection', address: '127.0.0.1' };
const context = { identity };
function setup() {
    const logger = { debug() {}, error() {} };
    const tickets = new Map();
    const metadata = {
        '/aurora/services/WoWService/subRegions/1-1-0/virtualRealms/1-1-1': {
            update: { name: 'Test', version: { versionMajor: 7, versionMinor: 3, versionRevision: 5, versionBuild: 26972 } },
            realmUID: '11111111-1111-4111-8111-111111111111', namespace: 'test', expansion: 6, available: true, securityLevel: 0, region: 1, build: 26972, isHidden: true, isTournament: false, deleting: false, endpoints: [{ family: 1, addresses: [] }], gameServerId: 'server'
        },
        '/aurora/services/WoWService/subRegions/1-1-0/gameServers/server': { endpoints: [{ family: 1, addresses: [] }] }
    };
    const models = { GameAccountCharacters: { findAll: async () => [] }, GameAccountPrivilege: { findOne: async () => null }, IPBan: { findOne: async () => null }, Account: { findByPk: async () => ({ id: '1' }) },
        GameAccount: { findAll: async () => [{ region: 1 }], findByPk: async id => ({ id, accountId: '1', region: 1, expansion: 6, program: 'WoW' }) } };
    const store = {
        run: async operation => operation({ set: async (key, value) => { tickets.set(key, JSON.parse(value)); return 'OK'; } }),
        getConnectionIdentity: async () => ({ accountId: '1', address: identity.address, applicationVersion: 26972 }),
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
    return { service: new GameUtilitiesService({ logger, store, models, realmDirectory: store }), tickets, store, models };
}
const blob = (name, value) => ({ blobValue: Buffer.from(name + ':' + JSON.stringify(value) + '\0') });
const unpack = buffer => zlib.inflateSync(buffer.subarray(4)).toString();

async function ticket(service, requestedIdentity = { gameAccountID: '9007199254740993' }, client = {}) {
    return service.commandHandlers.RealmListTicketRequest({
        Identity: blob('JSONRealmListTicketIdentity', requestedIdentity),
        ClientInfo: blob('JSONRealmListTicketClientInformation', { info: {
            version: { versionMajor: 7, versionMinor: 3, versionRevision: 5, versionBuild: 26972 }, secret: Array(32).fill(7), ...client
        } })
    }, null, context);
}

test('realm ticket, discovery, and join preserve payloads and identity using the injected directory', async () => {
    const { service, tickets } = setup();
    const params = await ticket(service);
    const list = await service.commandHandlers.RealmListRequest(params, { stringValue: '1-1-0' }, context);
    assert.match(unpack(list.RealmList.blobValue), /"name":"Test"/);
    assert.match(unpack(list.RealmList.blobValue), /"flags":2/);
    const response = await service.commandHandlers.RealmJoinRequest({ ...params, RealmAddress: { uintValue: Long.fromNumber(0x01010001) } }, { stringValue: '1-1-0' }, context);
    assert.match(unpack(response.ServerAddresses.blobValue), /"family":1/);
    assert.equal(response.RealmJoinTicket.blobValue.length, 20);
    assert.equal(response.JoinSecret.blobValue.length, 32);
    const stored = [...tickets.values()].find(value => value.join_secret);
    assert.equal(stored.version, 1);
    assert.equal(stored.game_account_id, '9007199254740993');
    assert.equal(stored.client_secret, '07'.repeat(32));
    assert.equal(stored.expansion, 6);
    assert.match([...tickets.keys()].find(key => key.includes('/tickets/')), /^\/skymist\/v1\/realms\/[a-f0-9-]+\/tickets\/[a-f0-9]{40}$/);
    const discovery = { identity, request: { attributeKey: 'Command_RealmListRequest_v1_b9' }, response: { attributeValue: [] } };
    assert.equal(await service.GetAllValuesForAttribute(discovery), 0);
    assert.deepEqual(discovery.response.attributeValue.map(value => value.stringValue), ['1-1-0']);
});

test('realm ticket creation and join failures retain the existing RPC status', async () => {
    const { service, store } = setup();
    store.setJSON = async () => { throw new Error('Redis unavailable'); };
    await assert.rejects(ticket(service), error => error === 0x80000076);
    store.getMetadataJSON = async () => { throw new Error('Missing realm'); };
    await assert.rejects(service.commandHandlers.RealmJoinRequest({ RealmListTicket: { blobValue: Buffer.from('unknown') },
        RealmAddress: { uintValue: Long.fromNumber(0x01010001) } }, { stringValue: '1-1-0' }, context), error => error === 0x80000075);
});
test('realm discovery returns the selected GameAccount character counts through the model API', async () => {
    const { service, models } = setup();
    models.GameAccountCharacters.findAll = async ({ where }) => {
        assert.equal(where.game_account_id, '9007199254740993');
        return [{ realm_uid: '11111111-1111-4111-8111-111111111111', character_count: 4 }];
    };
    const params = await ticket(service);
    const list = await service.commandHandlers.RealmListRequest(params, { stringValue: '1-1-0' }, context);
    assert.match(unpack(list.CharacterCountList.blobValue), /"count":4/);
});

test('realm tickets cannot cross connections or survive a new game-account ban or reassignment', async () => {
    const { service, models } = setup();
    const issued = await ticket(service);
    await assert.rejects(service.commandHandlers.RealmListRequest(issued, { stringValue: '1-1-0' },
        { identity: { ...identity, connectionId: 'another' } }));
    models.GameAccount.findByPk = async id => ({ id, accountId: '1', isBanned: true, program: 'WoW' });
    await assert.rejects(service.commandHandlers.RealmListRequest(issued, { stringValue: '1-1-0' }, context));
    await assert.rejects(ticket(service));
    models.GameAccount.findByPk = async id => ({ id, accountId: '2', program: 'WoW' });
    await assert.rejects(service.commandHandlers.RealmJoinRequest({ ...issued, RealmAddress: { uintValue: Long.fromNumber(0x01010001) } },
        { stringValue: '1-1-0' }, context));
});


test('Legion numeric gameAccountID issues a ticket with the normalized internal identity', async () => {
    const { service, tickets } = setup();
    await ticket(service, { gameAccountID: 42, gameAccountRegion: 1 });
    assert.equal([...tickets.values()][0].identity.gameAccountId, '42');
});

test('invalid or unauthorized realm-ticket identities never write tickets', async () => {
    for (const supplied of [{}, { gameAccountId: 42 }, { gameAccountID: 0 }, { gameAccountID: 'invalid' }]) {
        const { service, tickets } = setup();
        await assert.rejects(ticket(service, supplied), error => error === 10);
        assert.equal(tickets.size, 0);
    }
    for (const overrides of [{ accountId: '2' }, { isBanned: true }, { isSuspended: true }, { program: 'D3' }]) {
        const { service, models, tickets } = setup();
        models.GameAccount.findByPk = async id => ({ id, accountId: '1', region: 1, program: 'WoW', ...overrides });
        await assert.rejects(ticket(service), error => error === 10);
        assert.equal(tickets.size, 0);
    }
});

test('offline or incompatible realms cannot issue a join ticket', async () => {
    for (const overrides of [{ available: false }, { build: 15595 }, { region: 2 }, { securityLevel: 3 }]) {
        const { service, store, tickets } = setup();
        const issued = await ticket(service);
        const original = store.getMetadataJSON;
        store.getMetadataJSON = async key => ({ ...await original(key), ...overrides });
        await assert.rejects(service.commandHandlers.RealmJoinRequest({ ...issued, RealmAddress: { uintValue: Long.fromNumber(0x01010001) } }, { stringValue: '1-1-0' }, context));
        assert.equal([...tickets.values()].filter(value => value.join_secret).length, 0);
    }
});

test('realm list preserves all sixteen ID bits and unsigned region bits', async () => {
    const { service, store } = setup();
    store.listMetadataJSON = async () => ({ '/aurora/services/WoWService/subRegions/1-1-0/virtualRealms/1-1-513': {
        expansion: 6,
        update: { name: 'Wide ID', version: { versionMajor: 7, versionMinor: 3, versionRevision: 5, versionBuild: 26972 } }
    } });
    const issued = await ticket(service);
    const listed = await service.commandHandlers.RealmListRequest(issued, { stringValue: '1-1-0' }, context);
    assert.match(unpack(listed.RealmList.blobValue), /"wowRealmAddress":16843265/);
});

test('native numeric platform FourCCs become canonical RealmJoin platform strings', async () => {
    for (const [platform, expected] of [[1466840628, 'Wn64'], [0x57696E00, 'Win'], [0x4D633634, 'Mc64'], ['Win', 'Win']]) {
        const { service, tickets } = setup();
        const issued = await ticket(service, undefined, { platform });
        // Existing list tickets can predate canonical platform storage.
        for (const value of tickets.values()) { if (value.info) value.info.platform = platform; }
        await service.commandHandlers.RealmJoinRequest({ ...issued, RealmAddress: { uintValue: Long.fromNumber(0x01010001) } },
            { stringValue: '1-1-0' }, context);
        assert.equal([...tickets.values()].find(value => value.join_secret).platform, expected);
    }
});

test('invalid platform metadata is rejected before writing a RealmList ticket', async () => {
    for (const platform of [-1, 0x100000000, 1.5, 0, null, {}, 'too-long', 0xD76E3634]) {
        const { service, tickets } = setup();
        await assert.rejects(ticket(service, undefined, { platform }), error => error === 10);
        assert.equal(tickets.size, 0);
    }
});
