'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const loadProto = require('../utils/protobuf');

const AuthenticationService = require('../services/authentication');
const root = loadProto('proto/bgs/low/pb/client/authentication_service.proto');
const LogonResult = root.lookupType('bgs.protocol.authentication.v1.LogonResult');
const EntityId = root.lookupType('bgs.protocol.EntityId');

function setup({ missingAccount = false, program = 'WoW', fail, banned = false, suspended = false, banExpiresAt, wrongConnection = false } = {}) {
    const messages = [];
    const writes = [];
    let closed = 0;
    const models = { Account: {}, GameAccount: {}, IPBan: { findOne: async () => null } };
    const logger = { debug() {}, error() {} };
    const store = {
        getMetadata: async () => {
            if (fail === 'read') { throw new Error('Redis rejected'); }
            return 'https://example.test/login/';
        },
        getLoginTicket: async () => {
            if (fail === 'read' || fail === 'program') { throw new Error('Redis rejected'); }
            return { accountId: missingAccount ? null : '9007199254740993', program, connectionId: wrongConnection ? 'another-connection' : 'test-connection', address: '127.0.0.1' };
        },
        setConnectionIdentity: async () => {},
        createLoginTicket: async (ticket, program) => {
            if (fail === 'write') { throw new Error('Redis rejected'); }
            writes.push({ ticket, program });
        }
    };
    const amqpConnection = { createChannel: async () => {
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
            isBanned: banned, isSuspended: suspended, banExpiresAt,
            id: '9007199254740993', battleTag: 'Demo#1234',
            gameAccounts: [{ program: 'WoW', entityId: EntityId.fromObject({ high: '144115196671098711', low: '9007199254740995' }) }]
        };
    };
    return { messages, writes, closed: () => closed, service: new AuthenticationService({ logger, models, store, amqpConnection }) };
}

test('Logon publishes its challenge after atomic ticket creation and closes its callback channel', async () => {
    const state = setup();
    assert.equal(await state.service.Logon({ identity: { connectionId: 'test-connection', address: '127.0.0.1' }, queueName: 'client', request: { program: 'WoW', platform: 'Win' } }), 0);
    assert.equal(state.writes.length, 1);
    assert.equal(state.writes[0].program, 'WoW');
    assert.equal(state.messages.length, 1);
    assert.equal(state.messages[0][2].headers.serviceHash, 0xbbda171f);
    assert.equal(state.messages[0][2].headers.methodId, 3);
    const challengeType = loadProto('proto/bgs/low/pb/client/challenge_service.proto').lookupType('bgs.protocol.challenge.v1.ChallengeExternalRequest');
    const challenge = challengeType.decode(state.messages[0][1]);
    assert.equal(challenge.payload.toString(), 'https://example.test/login/' + state.writes[0].ticket);
    assert.equal(state.closed(), 1);
});

test('Logon propagates read, write, and channel rejection as an RPC error', async t => {
    for (const fail of ['read', 'write', 'channel']) {
        await t.test(fail, async () => {
            const state = setup({ fail });
            await assert.rejects(state.service.Logon({ identity: { connectionId: 'test-connection', address: '127.0.0.1' }, queueName: 'client', request: { program: 'WoW', platform: 'Win' } }), error => error === 1);
            assert.equal(state.messages.length, 0);
        });
    }
});

test('web credentials emit exactly one callback for success, missing identity, and dependency failure', async t => {
    for (const [options, status] of [[{}, 0], [{ missingAccount: true }, 0xA], [{ program: 'Other' }, 0xC],
        [{ fail: 'read' }, 1], [{ fail: 'program' }, 1], [{ fail: 'mysql' }, 1]]) {
        await t.test(JSON.stringify(options), async () => {
            const state = setup(options);
            assert.equal(await state.service.VerifyWebCredential({ identity: { connectionId: 'test-connection', address: '127.0.0.1' }, queueName: 'client', request: { webCredentials: Buffer.from('ticket') } }), 0);
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


test('credential verification rechecks bans, expiry, suspension and connection identity', async () => {
    for (const [options, allowed] of [[{ banned: true }, false], [{ suspended: true }, false],
        [{ banned: true, banExpiresAt: new Date('2020-01-01T00:00:00Z') }, true], [{ wrongConnection: true }, false]]) {
        const state = setup(options);
        await state.service.VerifyWebCredential({ identity: { connectionId: 'test-connection', address: '127.0.0.1' },
            queueName: 'client', request: { webCredentials: Buffer.from('ticket') } });
        const response = LogonResult.decode(state.messages[0][1]);
        assert.equal(response.errorCode === 0, allowed);
    }
});
