'use strict';
const { sessionClient } = require('./support/memory-redis');
const assert = require('node:assert/strict');
const { test } = require('node:test');
const AccountService = require('../services/account');
const AuthenticationService = require('../services/authentication');
const loadProto = require('../utils/protobuf');
const types = loadProto('proto/bgs/low/pb/client/account_service.proto');
const EntityId = types.lookupType('bgs.protocol.EntityId');
const Response = types.lookupType('bgs.protocol.account.v1.GetGameAccountStateResponse');
const identity = { connectionId: 'fixture', address: '127.0.0.1' };
const accountId = '9007199254740993';
const id = EntityId.fromObject({ high: '144115196671098711', low: '9007199254740995' });
function setup(build = 15595) {
    const game = { id: id.low.toString(), accountId, entityId: id, program: 'WoW', region: 1, expansion: 3, wowLicenseIndex: 12, displayName: 'Display label' };
    const models = { Account: { findByPk: async () => ({ id: accountId }) }, GameAccount: { findByPk: async () => game } };
    const store = { run: operation => operation(sessionClient(async () => ({ accountId, address: identity.address, applicationVersion: build }), { set: async (key, value) => { store.opened = JSON.parse(value); return 'OK'; } })) };
    return { game, models, store, service: new AccountService({ models, store, logger: { debug() {} } }) };
}
test('15595 metadata encodes persisted alias while Legion preserves display name', async () => {
    for (const build of [15595, 26972]) {
        const state = setup(build);
        if (build === 26972) { state.game.expansion = 6; }
        const context = { identity, request: { gameAccountId: id, options: { fieldGameLevelInfo: true, fieldGameStatus: true } }, response: {} };
        await state.service.GetGameAccountStatus(context);
        const wire = Response.decode(Response.encode(Response.create(context.response)).finish());
        assert.equal(wire.state.gameLevelInfo.name, build === 15595 ? accountId + '#12' : 'Display label');
        assert.equal(wire.state.gameStatus.name, undefined); // Agreed protobuf has no display name field.
    }
});
test('15595 metadata rejects foreign, banned, incompatible and invalid license identities', async () => {
    for (const change of [{ accountId: '7' }, { isBanned: true }, { expansion: 6 }, { program: 'D3' }, { wowLicenseIndex: 0 }]) {
        const state = setup(); Object.assign(state.game, change);
        await assert.rejects(state.service.GetGameAccountStatus({ identity, request: { gameAccountId: id, options: {} }, response: {} }), e => e === 10);
    }
    const state = setup();
    await assert.rejects(state.service.GetGameAccountStatus({ identity, request: { gameAccountId: EntityId.fromObject({ high: '1', low: id.low }), options: {} }, response: {} }), e => e === 10);
});
test('15595 authentication selects only eligible expansion-three WoW licenses', async () => {
    const state = setup(), messages = [];
    state.models.Account.findOne = async () => ({ id: accountId, entityId: EntityId.fromObject({ high: '72057594037927936', low: accountId }), battleTag: 'Fixture#1559',
        gameAccounts: [state.game, { ...state.game, expansion: 6 }, { ...state.game, isBanned: true }, { ...state.game, program: 'D3' }] });
    state.store.getLoginTicket = async () => ({ accountId, program: 'WoW', applicationVersion: 15595, ...identity });
    const service = new AuthenticationService({ models: state.models, store: state.store, logger: { debug() {}, error() {} },
        amqpConnection: { createChannel: async () => ({ sendToQueue: (queue, message) => messages.push(message), close: async () => {} }) } });
    await service.VerifyWebCredential({ identity, queueName: 'fixture', request: { webCredentials: Buffer.from('ticket') } });
    const result = loadProto('proto/bgs/low/pb/client/authentication_service.proto').lookupType('bgs.protocol.authentication.v1.LogonResult').decode(messages[0]);
    assert.equal(result.errorCode, 0);
    assert.equal(result.gameAccountId.length, 1);
    assert.equal(result.gameAccountId[0].low.toString(), id.low.toString());
});
test('Legion authentication lists only expansion-six WoW licenses', async () => {
    const state = setup(26972), messages = [];
    const legion = { ...state.game, id: '9007199254740997', expansion: 6, entityId: EntityId.fromObject({ high: id.high, low: '9007199254740997' }) };
    state.models.Account.findOne = async () => ({ id: accountId, entityId: EntityId.fromObject({ high: '72057594037927936', low: accountId }), battleTag: 'Fixture#2697',
        gameAccounts: [state.game, legion, { ...legion, isSuspended: true }] });
    state.store.getLoginTicket = async () => ({ accountId, program: 'WoW', applicationVersion: 26972, ...identity });
    const service = new AuthenticationService({ models: state.models, store: state.store, logger: { debug() {}, error() {} },
        amqpConnection: { createChannel: async () => ({ sendToQueue: (queue, message) => messages.push(message), close: async () => {} }) } });
    await service.VerifyWebCredential({ identity, queueName: 'fixture', request: { webCredentials: Buffer.from('ticket') } });
    const result = loadProto('proto/bgs/low/pb/client/authentication_service.proto').lookupType('bgs.protocol.authentication.v1.LogonResult').decode(messages[0]);
    assert.equal(result.errorCode, 0);
    assert.deepEqual(result.gameAccountId.map(value => value.low.toString()), ['9007199254740997']);
    assert.equal(state.store.opened.applicationVersion, 26972);
});
