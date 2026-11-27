'use strict';
const assert = require('node:assert/strict');
const { test } = require('node:test');
const loadProto = require('../utils/protobuf');
const { RedisStore } = require('../utils/redis-store');
const { memoryRedis } = require('./support/memory-redis');
const AuthenticationService = require('../services/authentication');

const root = loadProto('proto/bgs/low/pb/client/authentication_service.proto');
const LogonResult = root.lookupType('bgs.protocol.authentication.v1.LogonResult');
const EntityId = root.lookupType('bgs.protocol.EntityId');
const WOW = 0x576f57;
const ACCOUNT = '9007199254740993';
const identity = (connectionId, address = '127.0.0.1') => ({ connectionId, address });

function setup() {
    const redis = memoryRedis();
    const store = {
        ...redis,
        createReconnectCredential: RedisStore.prototype.createReconnectCredential,
        consumeReconnectCredential: RedisStore.prototype.consumeReconnectCredential,
    };
    const account = {
        entityId: EntityId.fromObject({ high: '72057594037927936', low: ACCOUNT }),
        id: ACCOUNT,
        battleTag: 'Demo#1234',
        credentialVersion: 1,
        gameAccounts: [
            {
                program: 'WoW',
                region: 1,
                expansion: 3,
                entityId: EntityId.fromObject({ high: '144115196671098711', low: '9007199254740995' }),
            },
        ],
    };
    const models = {
        Account: { findOne: async () => account },
        GameAccount: {},
        IPBan: { findOne: async () => null },
    };
    const messages = [];
    const amqpConnection = {
        createChannel: async () => ({
            sendToQueue: (...args) => messages.push(args) && true,
            close: async () => {},
        }),
    };
    const service = new AuthenticationService({
        logger: { debug() {}, error() {} },
        models,
        store,
        amqpConnection,
    });
    const sessions = new Map();
    service.sessions.open = async (id, value) => {
        sessions.set(id.connectionId, {
            accountId: String(value.accountId),
            address: id.address,
            applicationVersion: value.applicationVersion,
            ...value.proof,
        });
    };
    service.sessions.resolve = async (context) => {
        const session = sessions.get(context.identity.connectionId);
        if (!session) {
            throw 0xa;
        }
        return { ...session, connectionId: context.identity.connectionId };
    };
    sessions.set('first', {
        accountId: ACCOUNT,
        address: '127.0.0.1',
        applicationVersion: 15595,
        credentialVersion: '1',
        authenticatorGeneration: '0',
        authenticatorVerifiedAt: 0,
    });
    async function generate(connectionId) {
        const context = { identity: identity(connectionId), request: { program: WOW }, response: {} };
        assert.equal(await service.GenerateWebCredentials(context), 0);
        return context.response.webCredentials;
    }
    async function reconnect(credential, connectionId, overrides = {}) {
        messages.length = 0;
        await service.Logon({
            identity: identity(connectionId, overrides.address),
            queueName: 'client',
            request: {
                program: 'WoW',
                platform: 'Wn64',
                applicationVersion: overrides.applicationVersion ?? 15595,
                cachedWebCredentials: credential,
            },
        });
        assert.equal(messages.length, 1, 'exactly one OnLogonComplete');
        return LogonResult.decode(messages[0][1]).errorCode;
    }
    return { redis, account, sessions, generate, reconnect };
}

test('reconnect credential logs a new connection on and opens its session', async () => {
    const f = setup();
    const credential = await f.generate('first');
    assert.equal(credential.length, 32);
    assert.ok(![...f.redis.values.values()].some((value) => value.includes(credential.toString('hex'))),
        'only the digest of the credential is stored');
    assert.equal(await f.reconnect(credential, 'second'), 0);
    assert.equal(f.sessions.get('second').accountId, ACCOUNT);
});

test('reconnect credential is single use and bound to address and build', async () => {
    const f = setup();
    let credential = await f.generate('first');
    assert.equal(await f.reconnect(credential, 'second'), 0);
    assert.equal(await f.reconnect(credential, 'third'), 0xa, 'consumed');
    credential = await f.generate('second');
    assert.equal(await f.reconnect(credential, 'third', { address: '10.0.0.9' }), 0xa, 'foreign address');
    credential = await f.generate('second');
    assert.equal(await f.reconnect(credential, 'third', { applicationVersion: 26972 }), 0xa, 'other build');
    assert.equal(await f.reconnect(Buffer.alloc(31), 'third'), 0xa, 'malformed');
});

test('issuing again on one connection revokes its previous credential', async () => {
    const f = setup();
    const previous = await f.generate('first');
    const current = await f.generate('first');
    assert.equal(await f.reconnect(previous, 'second'), 0xa);
    assert.equal(await f.reconnect(current, 'second'), 0);
});

test('reconnect rechecks bans and the authentication proof', async () => {
    let f = setup();
    let credential = await f.generate('first');
    f.account.isBanned = true;
    assert.equal(await f.reconnect(credential, 'second'), 0xa, 'banned since issue');
    f = setup();
    credential = await f.generate('first');
    f.account.credentialVersion = 2;
    assert.notEqual(await f.reconnect(credential, 'second'), 0, 'password changed since issue');
});

test('only an authenticated connection can issue a credential', async () => {
    const f = setup();
    await assert.rejects(f.generate('anonymous'), (error) => error === 0xa);
});
