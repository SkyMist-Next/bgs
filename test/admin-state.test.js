'use strict';
const assert = require('node:assert/strict');
const { test } = require('node:test');
const { blocked, banned, canonicalIP, trustedPeer, checkIP, principal, gameAccount } = require('../utils/admin-state');
const { parse, SIGNATURE } = require('../utils/proxy-v2');

function header(v6 = false) {
    const value = Buffer.alloc(v6 ? 52 : 28);
    SIGNATURE.copy(value);
    value[12] = 0x21; value[13] = v6 ? 0x21 : 0x11;
    value.writeUInt16BE(v6 ? 36 : 12, 14);
    if (v6) { value.writeUInt16BE(0x2001, 16); value.writeUInt16BE(0xdb8, 18); value[31] = 1; }
    else { Buffer.from([192, 0, 2, 1]).copy(value, 16); }
    return value;
}

test('PROXY v2 accepts IPv4/IPv6 fragments and preserves coalesced TLS bytes', () => {
    const hello = Buffer.from([0x16, 3, 3, 0, 4, 1, 2, 3, 4]);
    for (const v6 of [false, true]) {
        const value = header(v6);
        for (let i = 0; i < value.length; i++) { assert.equal(parse(value.subarray(0, i)), null); }
        const result = parse(Buffer.concat([value, hello]));
        assert.equal(result.address, v6 ? '2001:db8::1' : '192.0.2.1');
        assert.deepEqual(result.remaining, hello);
    }
});

test('PROXY v2 rejects missing, LOCAL, datagram, oversized and malformed TLV frames', () => {
    assert.throws(() => parse(Buffer.from('GET /')));
    for (const [offset, value] of [[12, 0x20], [13, 0x12], [14, 255], [15, 1]]) {
        const frame = header(); frame[offset] = value;
        assert.throws(() => parse(frame));
    }
    const frame = Buffer.concat([header(), Buffer.from([1, 0])]); frame.writeUInt16BE(14, 14);
    assert.throws(() => parse(frame));
    assert.equal(trustedPeer('::ffff:192.0.2.4', ['192.0.2.0/24']), true);
    assert.equal(trustedPeer('198.51.100.4', ['192.0.2.0/24']), false);
});

test('bans expire in UTC while suspension blocks independently and IPs canonicalize', async () => {
    const now = Date.parse('2026-11-02T16:00:00Z');
    assert.equal(banned({ isBanned: true }, now), true);
    assert.equal(banned({ isBanned: true, banExpiresAt: new Date(now) }, now), false);
    assert.equal(blocked({ isSuspended: true, isBanned: true, banExpiresAt: new Date(now - 1) }, now), true);
    assert.equal(canonicalIP('::ffff:192.0.2.1'), '192.0.2.1');
    assert.equal(canonicalIP('2001:0DB8:0:0:0:0:0:1'), '2001:db8::1');
    assert.throws(() => canonicalIP('192.0.2.0/24'));
    await assert.rejects(checkIP({ ipBansEnabled: true, IPBan: { findOne: async () => { throw new Error('DB failed'); } } }, '192.0.2.1'));
});

test('connection identity and parent ownership fail closed including stale tickets', async () => {
    const context = { identity: { connectionId: 'server-generated', address: '192.0.2.1' } };
    const models = { IPBan: { findOne: async () => null }, Account: { findByPk: async () => ({ id: '1' }) },
        GameAccount: { findByPk: async () => ({ accountId: '2' }) } };
    const store = { getConnectionIdentity: async () => ({ accountId: '1', address: '192.0.2.1' }) };
    const owner = await principal(models, store, context);
    await assert.rejects(gameAccount(models, owner, '3'), e => e === 0xA);
    store.getConnectionIdentity = async () => ({ accountId: '1', address: '192.0.2.2' });
    await assert.rejects(principal(models, store, context), e => e === 0xA);
    await assert.rejects(principal(models, store, {}), e => e === 0xA);
});

test('explicit Realm privilege zero wins and removing it restores global privilege', async () => {
    const { privilege } = require('../utils/admin-state');
    let override = { level: 0 };
    const models = { GameAccountPrivilege: { findOne: async ({ where }) => where.realmUid ? override : { level: 3 } } };
    assert.equal(await privilege(models, '1', 'realm-uid'), 0);
    override = null;
    assert.equal(await privilege(models, '1', 'realm-uid'), 3);
    models.GameAccountPrivilege.findOne = async () => null;
    assert.equal(await privilege(models, '1', 'realm-uid'), 0);
});

test('PROXY mode rejects untrusted peers and bounds missing-header admission time', async () => {
    const { PassThrough } = require('node:stream');
    const { proxyServer } = require('../utils/proxy-v2');
    const server = proxyServer({}, ['192.0.2.0/24'], () => assert.fail('Must not admit missing PROXY header'), { timeout: 10 });
    const spoof = new PassThrough(); spoof.remoteAddress = '198.51.100.1';
    server.emit('connection', spoof);
    assert.equal(spoof.destroyed, true);
    const silent = new PassThrough(); silent.remoteAddress = '192.0.2.1';
    server.emit('connection', silent);
    await new Promise(resolve => silent.once('close', resolve));
    assert.equal(silent.destroyed, true);
});

test('email preflight reports conflicting row IDs without issuing DDL or modifying records', async () => {
    const migration = require('../migrations/20261102000000-administration');
    const queries = [];
    const q = { sequelize: { query: async sql => { queries.push(sql); return [[{ id: '9007199254740993' }, { id: '2' }]]; } } };
    await assert.rejects(migration.up(q, {}), error => error.code === 'BGS_EMAIL_CONFLICT' && error.message.includes('9007199254740993'));
    assert.equal(queries.length, 1);
    assert.match(queries[0], /^SELECT/);
    await assert.rejects(migration.down(), /additive/);
});

test('disabled IP bans never query the database', async () => {
    await checkIP({ IPBan: { findOne: () => assert.fail('IP ban query while disabled') } }, '192.0.2.1');
});

test('enabled IP bans reject active records and allow expired records', async () => {
    const models = { ipBansEnabled: true, IPBan: { findOne: async () => ({ expiresAt: null }) } };
    await assert.rejects(checkIP(models, '192.0.2.1'), error => error === 0xA);
    models.IPBan.findOne = async () => ({ expiresAt: new Date(0) });
    await checkIP(models, '192.0.2.1');
});
