'use strict';
const assert = require('node:assert/strict');
const { test } = require('node:test');
const Long = require('long');
const Presence = require('../services/presence');
const wire = require('../social/wire');
const p = require('../social/presence-wire');
const { SocialError } = require('../social/errors');
const A = '9007199254740993', B = '9007199254740995', G = '9007199254740997';
const OBJ = '18446744073709551615';
function fixture() {
    const rows = new Map(), subscriptions = [];
    const owner = { accountId: A, sessionKey: 'a', route: {}, applicationVersion: 15595 };
    const game = { id: G, accountId: B, program: 'WoW', region: 1,
        entityId: { low: Long.fromString(G, true), high: Long.fromBits(p.WOW, 0x02000001, true) } };
    const profiles = new Map([[A, { id: A, battleTag: 'Viewer#1234', realIdEnabled: false }],
        [B, { id: B, battleTag: 'Friend#1234', realIdEnabled: true, givenName: 'Private', surname: 'Name' }]]);
    const control = { friends: true, rid: false, online: true, character: null, sessionBlocked: false };
    const models = {
        Account: { findByPk: async id => profiles.get(id) },
        GameAccount: { findByPk: async id => id === G ? game : null, findAll: async options => options.where.accountId === B ? [game] : [] },
        SocialSubscription: { findAll: async () => [] },
        SocialPresenceState: { findByPk: async subject => rows.get(subject), create: async input => {
            const row = { ...input, update: async changes => Object.assign(row, changes) }; rows.set(input.subject, row); return row;
        } },
        sequelize: { transaction: async action => action({ LOCK: { UPDATE: 'UPDATE' } }) }
    };
    const projectors = new Map();
    const runtime = {
        owner: async () => owner, register: (kind, projector) => projectors.set(kind, projector),
        sessionBlocked: async () => control.sessionBlocked,
        selectGame: async (current, selected) => { current.gameAccountId = selected; },
        graph: { assertAccess: async () => { if (!control.friends) { throw new SocialError('NOT_FRIENDS'); } },
            project: async () => control.friends ? { realIdVisible: control.rid, givenName: 'Private', surname: 'Name' } : null },
        recipients: async () => [], current: async () => null,
        subscribe: async (...args) => subscriptions.push(args), unsubscribe: async (...args) => subscriptions.push(args)
    };
    const worldPresence = { session: async () => control.online ? {} : null,
        get: async () => control.online ? { character: control.character } : null };
    const service = new Presence({ models, runtime, worldPresence, logger: { error() {}, debug() {} } });
    return { service, owner, control, profiles, game, rows, subscriptions, projectors };
}
async function rpc(f, name, request) {
    const service = f.service, method = service.methods.find(value => value.name === name);
    const requestType = service.rootNamespace.lookupType(method.requestType);
    const context = { header: { serviceId: 0, methodId: method.getOption('(bgs.protocol.method_options).id'), token: 1, objectId: OBJ } };
    const frame = await service.handleCall(context, requestType.encode(requestType.fromObject(request)).finish());
    const length = frame.readUInt16BE(0);
    const header = wire.type('rpc_types', 'bgs.protocol.Header').decode(frame.subarray(2, length + 2));
    const response = header.status ? null : service.rootNamespace.lookupType(method.responseType).decode(frame.subarray(length + 2));
    return { status: header.status, response };
}
function value(fields, program, group, field) { return fields.find(row => row.key.program === program && row.key.group === group && row.key.field === field)?.value; }
test('account projection separates BattleTag from consented Real ID and keeps game identity lossless', async () => {
    const f = fixture();
    const query = () => rpc(f, 'Query', { entityId: wire.account(B) });
    let result = await query(); assert.equal(result.status, 0);
    assert.equal(value(result.response.field, p.BN, 1, 1).stringValue, '');
    assert.equal(value(result.response.field, p.BN, 1, 4).stringValue, 'Friend#1234');
    assert.equal(value(result.response.field, p.BN, 1, 3).entityIdValue.low.toString(), G);
    assert.equal(result.response.field.find(row => row.key.field === 3).key.uniqueId.toString(), G);
    f.control.rid = true;
    result = await query(); assert.equal(value(result.response.field, p.BN, 1, 1).stringValue, 'Private Name');
    f.control.friends = false;
    assert.notEqual((await query()).status, 0);
});
test('presence join/delta uses ChannelState extension 101 and clears all fields after friendship loss', async () => {
    const f = fixture();
    const result = await rpc(f, 'Subscribe', { entityId: wire.account(B), objectId: OBJ, program: [p.BN] });
    assert.equal(result.status, 0);
    const call = f.subscriptions.at(-1);
    const row = { objectId: OBJ, filter: call[5] };
    const projector = f.projectors.get('presence');
    const snapshot = await projector.snapshot(f.owner, row);
    const join = projector.diff(null, snapshot, row)[0];
    assert.equal(join.methodId, 1); assert.equal(join.objectId, OBJ); assert.equal(join.worldHash, 0xDA660990);
    const type = wire.type('channel_service', 'bgs.protocol.channel.v1.JoinNotification');
    const decoded = type.decode(join.payload).channelState[p.EXTENSION];
    assert.equal(decoded.entityId.low.toString(), B); assert.ok(decoded.healing); assert.ok(decoded.fieldOperation.length);
    f.control.friends = false;
    const hidden = await projector.snapshot(f.owner, row);
    assert.deepEqual(hidden.fields, []);
    const frame = projector.diff(snapshot, hidden, row)[0];
    const delta = wire.type('channel_service', 'bgs.protocol.channel.v1.UpdateChannelStateNotification').decode(frame.payload);
    assert.equal(frame.methodId, 6); assert.ok(delta.stateChange[p.EXTENSION].fieldOperation.every(op => op.operation === 1));
});
test('client cannot forge active character, online state, another account, or another selected license', async () => {
    const f = fixture();
    const update = (entityId, field) => rpc(f, 'Update', { entityId, fieldOperation: [{ field }] });
    assert.notEqual((await update(wire.account(B), p.field(p.BN, 1, 2, { stringValue: 'forged' }))).status, 0);
    f.game.accountId = A;
    assert.notEqual((await update(f.game.entityId, p.field(p.WOW, 2, 10, { stringValue: 'forged' }))).status, 0);
    assert.notEqual((await update(f.game.entityId, p.field(p.BN, 2, 1, { boolValue: true }))).status, 0);
    f.owner.gameAccountId = '999';
    assert.notEqual((await rpc(f, 'Ownership', { entityId: f.game.entityId })).status, 0);
    assert.equal(f.rows.size, 0);
});
test('broadcast and AFK/DND updates validate variants, retain microsecond time, and are mutually exclusive', async () => {
    const f = fixture();
    const update = fields => rpc(f, 'Update', { entityId: wire.account(A), fieldOperation: fields.map(field => ({ field })) });
    assert.equal((await update([p.field(p.BN, 1, 2, { stringValue: 'hello' }), p.field(p.BN, 1, 7, { boolValue: true })])).status, 0);
    const state = f.rows.get('a:' + A).values;
    assert.equal(state.broadcast, 'hello'); assert.equal(state.afk, true); assert.equal(state.dnd, false);
    assert.ok(BigInt(state.broadcastTime) > 1000000000000000n);
    assert.notEqual((await update([p.field(p.BN, 1, 2, { stringValue: 'x'.repeat(128) })])).status, 0);
    assert.notEqual((await update([p.field(p.BN, 1, 7, { boolValue: true, stringValue: 'mixed' })])).status, 0);
    assert.equal((await update([p.field(p.BN, 1, 11, { boolValue: true })])).status, 0);
    assert.equal(f.rows.get('a:' + A).values.afk, false);
});
test('toon state disappears on withdrawal and expired session; there is no offline character list', async () => {
    const f = fixture();
    f.control.character = { name: 'Active', guid: '340282366920938463463374607431768211455', realm_address: 0x01000021,
        race: 1, class: 2, level: 85, zone: 12, faction: 0 };
    const query = () => rpc(f, 'Query', { entityId: f.game.entityId });
    let result = await query(); assert.equal(value(result.response.field, p.WOW, 2, 10).stringValue, 'Active');
    assert.equal(value(result.response.field, p.WOW, 2, 1).uintValue.toString(), '16777249');
    assert.equal(value(result.response.field, p.WOW, 2, 7).intValue.toString(), '2');
    assert.equal(value(result.response.field, p.WOW, 2, 11).uintValue.toString(), '33');
    assert.equal(value(result.response.field, p.WOW, 2, 12).uintValue.toString(), '18446744073709551615');
    f.control.character.faction = 2;
    result = await query(); assert.equal(value(result.response.field, p.WOW, 2, 7).intValue.toString(), '1');
    f.control.character = null;
    result = await query(); assert.equal(value(result.response.field, p.WOW, 2, 10), undefined);
    f.control.online = false;
    result = await query(); assert.equal(value(result.response.field, p.BN, 2, 1).boolValue, false);
    const account = await rpc(f, 'Query', { entityId: wire.account(B) });
    assert.equal(value(account.response.field, p.BN, 1, 3), undefined);
});
