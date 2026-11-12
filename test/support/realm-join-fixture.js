'use strict';
const { memoryRedis, seedSession } = require('./memory-redis');

const identity = { connectionId: 'test-connection', address: '127.0.0.1' };
const REALM_UID = '11111111-1111-4111-8111-111111111111';
const VERSIONS = { 15595: [4, 3, 4], 26972: [7, 3, 5] };
const EXPANSION = { 15595: 3, 26972: 6 };

function realmRow(build = 26972, overrides = {}) {
    const [major, minor, revision] = VERSIONS[build];
    return { realm_uid: REALM_UID, namespace: 'test', region: 1, battlegroup: 1, realm_id: 1, name: 'Test', timezone: 1, game_type: 0,
        population: 1, available: 1, security_level: 0, expansion: EXPANSION[build], build,
        version_major: major, version_minor: minor, version_revision: revision,
        endpoints: JSON.stringify([{ family: 1, addresses: [] }]), ...overrides };
}
// One authenticated client of the given build owning licence 9007199254740993 on region 1.
function realmFixture(build = 26972) {
    const now = Date.now();
    const redis = memoryRedis({ clock: () => now });
    seedSession(redis, identity.connectionId, { accountId: '1', address: identity.address, applicationVersion: build });
    const rows = [realmRow(build)];
    const state = { game: { accountId: '1', region: 1, expansion: EXPANSION[build], program: 'WoW', wowLicenseIndex: 2 }, privilege: null, counts: [] };
    const models = {
        GameAccountCharacters: { findAll: async query => { state.countQuery = query; if (state.countError) { throw state.countError; } return state.counts; } },
        GameAccountPrivilege: { findOne: async () => state.privilege },
        IPBan: { findOne: async () => null },
        Account: { findByPk: async () => ({ id: '1' }) },
        GameAccount: { findAll: async () => [{ ...state.game, id: '9007199254740993' }], findByPk: async id => ({ ...state.game, id }) }
    };
    const realmDirectory = { rows: async () => { if (state.directoryError) { throw state.directoryError; } return rows.map(row => ({ ...row })); } };
    const version = Object.fromEntries(['versionMajor', 'versionMinor', 'versionRevision'].map((key, i) => [key, VERSIONS[build][i]]));
    const clientInfo = (info = {}) => ({ info: { version: { ...version, versionBuild: build }, secret: Array(32).fill(7), ...info } });
    return { redis, rows, state, models, realmDirectory, clientInfo, context: { identity }, build };
}
const joinTickets = redis => [...redis.values].filter(([key]) => key.includes('/tickets/')).map(([key, value]) => ({ key, record: JSON.parse(value) }));
module.exports = { realmFixture, realmRow, joinTickets, identity, REALM_UID };
