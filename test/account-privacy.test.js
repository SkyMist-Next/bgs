'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const AccountService = require('../services/account');
const loadProto = require('../utils/protobuf');
const Header = loadProto('proto/bgs/low/pb/client/rpc_types.proto').lookupType('bgs.protocol.Header');
const ACCOUNT = '9007199254740993';
const ACCOUNT_HIGH = '72057594037927936';

function fixture() {
    const state = {
        account: { id: ACCOUNT, credentialVersion: '1', authenticatorGeneration: '0', authenticatorState: 0 },
        identity: { accountId: ACCOUNT, address: '192.0.2.1', credentialVersion: '1', authenticatorGeneration: '0',
            realIdEnabled: true }, // Cached identity fields must never determine current privacy.
        queries: []
    };
    const models = { Account: { findByPk: async id => {
        state.queries.push(id);
        assert.equal(id, ACCOUNT);
        state.onRead?.(state.queries.length);
        return state.account ? { ...state.account } : null;
    } } };
    const store = { getConnectionIdentity: async id => {
        assert.equal(id, 'connection');
        return state.identity;
    } };
    state.service = new AccountService({ models, store, logger: { debug() {}, error() {} } });
    return state;
}

async function privacy(state, request = {}, identity = { connectionId: 'connection', address: '192.0.2.1' }) {
    const service = state.service;
    const method = service.methods.find(value => value.name === 'GetAccountState');
    const type = service.rootNamespace.lookupType(method.requestType);
    const payload = type.encode(type.fromObject({ entityId: { high: ACCOUNT_HIGH, low: ACCOUNT },
        options: { fieldPrivacyInfo: true }, ...request })).finish();
    const context = { identity, header: { serviceId: 0, serviceHash: service.getServiceHash(), token: 19,
        methodId: method.getOption('(bgs.protocol.method_options).id') } };
    const frame = await service.handleCall(context, payload);
    const length = frame.readUInt16BE(0);
    const header = Header.decode(frame.subarray(2, length + 2));
    const response = service.rootNamespace.lookupType(method.responseType).decode(frame.subarray(length + 2));
    return { status: header.status, response, frame };
}

test('account privacy wire flags default to opt-out and honor only explicit database opt-in', async () => {
    const state = fixture();
    for (const value of [undefined, null, false, 0, 'true', '1', true, 1]) {
        state.account.realIdEnabled = value;
        const result = await privacy(state);
        assert.equal(result.status, 0);
        const info = result.response.state.privacyInfo;
        assert.equal(info.isUsingRid, value === true || value === 1);
        assert.equal(info.isVisibleForViewFriends, false);
        assert.equal(Object.hasOwn(info, 'isVisibleForViewFriends'), true, 'False must be present on the wire');
        assert.equal(info.isHiddenFromFriendFinder, true);
    }
});

test('each privacy read observes opt-out while private names stay private', async () => {
    const state = fixture();
    Object.assign(state.account, { realIdEnabled: true, givenName: 'PrivateGiven', surname: 'PrivateSurname' });
    assert.equal((await privacy(state)).response.state.privacyInfo.isUsingRid, true);
    state.account.realIdEnabled = false;
    const result = await privacy(state);
    assert.equal(result.response.state.privacyInfo.isUsingRid, false);
    assert.equal(state.account.givenName, 'PrivateGiven');
    assert.equal(result.frame.includes(Buffer.from('PrivateGiven')), false);
    assert.equal(result.frame.includes(Buffer.from('PrivateSurname')), false);
    assert.deepEqual(state.queries, [ACCOUNT, ACCOUNT, ACCOUNT, ACCOUNT]);
});

test('privacy options use the nested protobuf fields and allow all-fields requests', async () => {
    const state = fixture();
    state.account.realIdEnabled = true;
    for (const options of [undefined, {}, { fieldPrivacyInfo: false }]) {
        const result = await privacy(state, { options });
        assert.equal(result.status, 0);
        assert.equal(Object.hasOwn(result.response.state, 'privacyInfo'), false);
    }
    assert.equal((await privacy(state, { options: { allFields: true } })).response.state.privacyInfo.isUsingRid, true);
});

test('privacy rejects missing, noncanonical and foreign account entities', async () => {
    for (const entityId of [undefined, {}, { high: '0', low: ACCOUNT },
        { high: '144115188075855872', low: ACCOUNT }, { high: ACCOUNT_HIGH, low: '9007199254740995' }]) {
        const state = fixture();
        const result = await privacy(state, { entityId });
        assert.equal(result.status, 0xA);
        assert.equal(Object.hasOwn(result.response, 'state'), false);
        assert.deepEqual(state.queries, [ACCOUNT]);
    }
});

test('privacy requires a current authenticated principal and rechecks revocation before disclosure', async () => {
    for (const revoke of [
        state => { state.identity = null; },
        state => { state.identity.address = '192.0.2.2'; },
        state => { state.account = null; },
        state => { state.account.isBanned = true; },
        state => { state.account.isSuspended = true; },
        state => { state.account.credentialVersion = '2'; },
        state => { state.account.authenticatorGeneration = '1'; },
        state => { state.account.authenticatorState = 2; }
    ]) {
        const state = fixture();
        state.account.realIdEnabled = true;
        revoke(state);
        assert.equal((await privacy(state)).status, 0xA);
    }
    for (const revoke of [state => { state.account = null; },
        state => { state.account.isBanned = true; }, state => { state.account.credentialVersion = '2'; }]) {
        const state = fixture();
        state.account.realIdEnabled = true;
        state.onRead = count => { if (count === 2) { revoke(state); } };
        assert.equal((await privacy(state)).status, 0xA);
    }
    assert.equal((await privacy(fixture(), {}, {})).status, 0xA);
});
