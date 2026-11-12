'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { ClientSessions, eligibleGame } = require('../utils/client-sessions');
const { memoryRedis } = require('./support/memory-redis');

const KEY = '/aurora/connections/connection-1';
const identity = { connectionId: 'connection-1', address: '192.0.2.1' };
const context = { identity };
const denied = error => error === 0xA;

function fixture({ build = 26972 } = {}) {
    let now = 1_900_000_000_000;
    const redis = memoryRedis({ clock: () => now });
    const state = { account: { id: '1', credentialVersion: '1' }, ipBan: null, ipError: null,
        games: new Map([['7', { id: 7, accountId: 1, program: 'WoW', expansion: 6 }], ['8', { id: 8, accountId: 1, program: 'WoW', expansion: 3 }],
            ['9', { id: 9, accountId: 2, program: 'WoW', expansion: 6 }], ['10', { id: 10, accountId: 1, program: 'WoW', expansion: 6, isBanned: true }]]) };
    const models = { ipBansEnabled: true,
        IPBan: { findOne: async () => { if (state.ipError) { throw state.ipError; } return state.ipBan; } },
        Account: { findByPk: async id => id === '1' ? state.account : null },
        GameAccount: { findByPk: async id => state.games.get(id) || null } };
    const sessions = new ClientSessions(redis, models);
    return { redis, state, sessions, models, build, advance: ms => { now += ms; } };
}
async function opened(options) {
    const f = fixture(options);
    await f.sessions.open(identity, { accountId: 1, proof: { credentialVersion: '1' }, applicationVersion: f.build });
    return f;
}

test('an opened session resolves for its connection and slides its expiry', async () => {
    const f = await opened();
    assert.equal(await f.redis.client.pTTL(KEY), 300000);
    f.advance(200000);
    const session = await f.sessions.resolve(context);
    assert.deepEqual(session, { accountId: '1', address: identity.address, credentialVersion: '1', applicationVersion: 26972, connectionId: 'connection-1' });
    assert.equal(await f.redis.client.pTTL(KEY), 300000);
    f.advance(100000);
    await f.sessions.touch('connection-1');
    assert.equal(await f.redis.client.pTTL(KEY), 300000);
    f.advance(300000);
    await assert.rejects(f.sessions.resolve(context), denied);
});

test('missing, foreign, revoked or banned sessions are denied by resolve and absent from current', async () => {
    for (const [change, expected] of [
        [() => {}, null],
        [f => f.redis.values.delete(KEY), 'gone'],
        [f => { f.state.account = { ...f.state.account, isSuspended: true }; }, 'revoked'],
        [f => { f.state.account = { ...f.state.account, credentialVersion: '2' }; }, 'revoked'],
        [f => { f.state.ipBan = { expiresAt: null }; }, 'revoked']
    ]) {
        const f = await opened(); change(f);
        const current = await f.sessions.current('connection-1', { accountId: '1', address: identity.address });
        if (expected) {
            await assert.rejects(f.sessions.resolve(context), denied);
            assert.equal(current, null);
        } else {
            assert.equal((await f.sessions.resolve(context)).accountId, '1');
            assert.equal(current.connectionId, 'connection-1');
        }
    }
    const f = await opened();
    await assert.rejects(f.sessions.resolve({ identity: { ...identity, address: '192.0.2.2' } }), denied);
    await assert.rejects(f.sessions.resolve({}), denied);
    assert.equal(await f.sessions.current('connection-1', { accountId: '2', address: identity.address }), null);
    assert.equal(await f.sessions.current('connection-1', { accountId: '1', address: '192.0.2.2' }), null);
});

test('current preserves recoverable state when a dependency fails and never refreshes expiry', async () => {
    const f = await opened();
    f.advance(1000);
    f.state.ipError = new Error('SQL unavailable');
    await assert.rejects(f.sessions.current('connection-1', { accountId: '1', address: identity.address }), /SQL unavailable/);
    assert.equal(await f.redis.client.pTTL(KEY), 299000);
});

test('selectGame binds one eligible owned license without extending the session', async () => {
    const f = await opened();
    const session = await f.sessions.resolve(context);
    f.advance(1000);
    assert.equal((await f.sessions.selectGame(session, '7')).gameAccountId, '7');
    assert.equal(JSON.parse(f.redis.values.get(KEY)).gameAccountId, '7');
    assert.equal(await f.redis.client.pTTL(KEY), 299000);
    assert.equal((await f.sessions.selectGame(session, '7')).gameAccountId, '7');
    const selected = await f.sessions.resolve(context);
    await assert.rejects(f.sessions.selectGame(selected, '8'), denied);
    await assert.rejects(f.sessions.selectGame(session, '8'), denied);
    for (const game of ['9', '10', '0', 'x']) { await assert.rejects((await opened()).sessions.selectGame(session, game), denied); }
    f.redis.values.delete(KEY);
    await assert.rejects((await opened()).sessions.selectGame({ ...session, address: '192.0.2.2' }, '7'), denied);
    await assert.rejects(f.sessions.selectGame(session, '7'), denied);
});

test('owned games follow the client build and ban state', async () => {
    const legion = await opened(), session = await legion.sessions.resolve(context);
    assert.equal((await legion.sessions.ownedGame(session, '7')).id, 7);
    await assert.rejects(legion.sessions.ownedGame(session, '8'), denied);
    await assert.rejects(legion.sessions.ownedGame(session, '9'), denied);
    await assert.rejects(legion.sessions.ownedGame(session, '10'), denied);
    assert.equal((await legion.sessions.ownedGame(session, '10', { includeBlocked: true })).id, 10);
    await assert.rejects(legion.sessions.ownedGame(session, 2 ** 53 + 2), denied);
    const cataclysm = await opened({ build: 15595 });
    assert.equal((await cataclysm.sessions.ownedGame(await cataclysm.sessions.resolve(context), '8')).id, 8);
    await assert.rejects(cataclysm.sessions.ownedGame(await cataclysm.sessions.resolve(context), '7'), denied);
});

test('ending a session removes it', async () => {
    const f = await opened();
    await f.sessions.end('connection-1');
    await assert.rejects(f.sessions.resolve(context), denied);
});

test('game eligibility is strict per known client build', () => {
    const cataclysm = { program: 'WoW', expansion: 3 }, legion = { program: 'WoW', expansion: 6 }, other = { program: 'D3', expansion: 0 };
    assert.equal(eligibleGame(cataclysm, 15595), true);
    assert.equal(eligibleGame(legion, 15595), false);
    assert.equal(eligibleGame(legion, 26972), true);
    assert.equal(eligibleGame(cataclysm, 26972), false);
    assert.equal(eligibleGame({ ...legion, program: 'D3' }, 26972), false);
    assert.equal(eligibleGame(other, undefined), true);
    assert.equal(eligibleGame({ ...other, isSuspended: true }, undefined), false);
    assert.equal(eligibleGame({ ...legion, isBanned: true }, 26972), false);
    assert.equal(eligibleGame({ ...legion, isBanned: true }, 26972, { includeBlocked: true }), true);
    assert.equal(eligibleGame(null, 26972, { includeBlocked: true }), false);
});
