'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const loadProto = require('../utils/protobuf');

// Substitute only the configured database boundary; use real services and protobuf codecs.
const modelsPath = require.resolve('../models');
const models = { Account: {}, GameAccount: {} };
require.cache[modelsPath] = { exports: models };
const AuthenticationService = require('../services/authentication');
const root = loadProto('proto/bgs/low/pb/client/authentication_service.proto');
const LogonResult = root.lookupType('bgs.protocol.authentication.v1.LogonResult');
const EntityId = root.lookupType('bgs.protocol.EntityId');

function setup(t, { missingAccount = false, program = 'WoW', fail } = {}) {
    const messages = [];
    const writes = [];
    let closed = 0;
    const old = { logger: global.logger, etcd3: global.etcd3, amqpConnection: global.amqpConnection };
    t.after(() => Object.assign(global, old));
    global.logger = { debug() {}, error() {} };
    global.etcd3 = {
        get: path => ({ string: async () => {
            if (fail === 'read' || fail === 'program' && path.endsWith('/program')) {
                throw new Error('etcd rejected');
            }
            if (path.endsWith('/accountId')) { return missingAccount ? null : '9007199254740993'; }
            if (path.endsWith('/program')) { return program; }
            return 'https://example.test/login/';
        } }),
        lease: seconds => {
            assert.equal(seconds, 30);
            return { put: path => ({ value: value => ({ exec: async () => {
                if (fail === 'write') { throw new Error('lease rejected'); }
                writes.push({ path, value });
            } }) }) };
        }
    };
    global.amqpConnection = { createChannel: async () => {
        if (fail === 'channel') { throw new Error('channel rejected'); }
        return {
            sendToQueue: (...args) => { messages.push(args); return true; },
            close: async () => { closed++; }
        };
    } };
    models.Account.findOne = async query => {
        if (fail === 'mysql') { throw new Error('query rejected'); }
        assert.equal(query.where.id, '9007199254740993');
        assert.equal(query.include[0].as, 'gameAccounts');
        return {
            entityId: EntityId.fromObject({ high: '72057594037927936', low: '9007199254740993' }),
            battleTag: 'Demo#1234',
            gameAccounts: [{ program: 'WoW', entityId: EntityId.fromObject({ high: '144115196671098711', low: '9007199254740995' }) }]
        };
    };
    return { messages, writes, closed: () => closed, service: new AuthenticationService() };
}

test('Logon publishes its challenge after both ticket writes and closes its callback channel', async t => {
    const state = setup(t);
    assert.equal(await state.service.Logon({ queueName: 'client', request: { program: 'WoW', platform: 'Win' } }), 0);
    assert.equal(state.writes.length, 2);
    assert.equal(state.writes[1].path, state.writes[0].path + '/program');
    assert.equal(state.writes[1].value, 'WoW');
    assert.equal(state.messages.length, 1);
    assert.equal(state.messages[0][2].headers.serviceHash, 0xbbda171f);
    assert.equal(state.messages[0][2].headers.methodId, 3);
    const challengeType = loadProto('proto/bgs/low/pb/client/challenge_service.proto').lookupType('bgs.protocol.challenge.v1.ChallengeExternalRequest');
    const challenge = challengeType.decode(state.messages[0][1]);
    assert.equal(challenge.payload.toString(), 'https://example.test/login/' + state.writes[0].value);
    assert.equal(state.closed(), 1);
});

test('Logon propagates read, write, and channel rejection as an RPC error', async t => {
    for (const fail of ['read', 'write', 'channel']) {
        await t.test(fail, async t => {
            const state = setup(t, { fail });
            await assert.rejects(state.service.Logon({ queueName: 'client', request: { program: 'WoW', platform: 'Win' } }), error => error === 1);
            assert.equal(state.messages.length, 0);
        });
    }
});

test('web credentials emit exactly one callback for success, missing identity, and dependency failure', async t => {
    for (const [options, status] of [[{}, 0], [{ missingAccount: true }, 0xA], [{ program: 'Other' }, 0xC],
        [{ fail: 'read' }, 1], [{ fail: 'program' }, 1], [{ fail: 'mysql' }, 1]]) {
        await t.test(JSON.stringify(options), async t => {
            const state = setup(t, options);
            assert.equal(await state.service.VerifyWebCredential({ queueName: 'client', request: { webCredentials: Buffer.from('ticket') } }), 0);
            assert.equal(state.messages.length, 1);
            assert.equal(state.messages[0][2].headers.methodId, 5);
            const result = LogonResult.decode(state.messages[0][1]);
            assert.equal(result.errorCode, status);
            if (status === 0) {
                assert.equal(result.accountId.low.toString(), '9007199254740993');
                assert.equal(result.gameAccountId[0].low.toString(), '9007199254740995');
            }
            else {
                assert.equal(result.accountId, null);
            }
            assert.equal(state.closed(), 1);
        });
    }
});
