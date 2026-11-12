'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { randomUUID } = require('node:crypto');
const { DataTypes } = require('sequelize');
const Long = require('long');
const { fixture } = require('./support/legacy-chat-fixture');
const { STATUS, LIMITS, CLOSURE_SNAPSHOT_CAPACITY, entity, NAMESPACE, FILE } = require('../social/legacy-chat');
const Service = require('../services/legacy_chat');
const loadProto = require('../utils/protobuf');
const define = require('../models/sociallegacy');
const code = name => error => error.status === STATUS[name];
const A = '9007199254740993', B = '9007199254740995', C = '9007199254740997';
const GA = '9007199254741003', GB = '9007199254741005', GC = '9007199254741007';

async function setup(t) {
    const f = fixture(); t.after(() => f.sequelize.close());
    const a = await f.game(GA, A), b = await f.game(GB, B), c = await f.game(GC, C);
    for (const actor of [a, b, c]) { await f.subscribe(actor); }
    f.friend(A, B); f.friend(A, C);
    return Object.assign(f, { a, b, c });
}
async function group(f, token) {
    const context = f.context(f.a, { first: entity(f.b.game), second: entity(f.c.game) }, token);
    const snapshot = await f.chat.create(context);
    return { context, snapshot, id: snapshot.affectedGroupId };
}

test('custom descriptors, method IDs and uint64/entity fields stay distinct from Legion services', () => {
    const root = loadProto(FILE);
    const service = root.lookupService(NAMESPACE + 'LegacyChatService');
    assert.equal(service.getOption('(bgs.protocol.service_options).descriptor_name'), NAMESPACE + 'LegacyChatService');
    assert.deepEqual(service.methodsArray.map(method => [method.name, method.getOption('(bgs.protocol.method_options).id')]),
        [['Subscribe', 1], ['Create', 2], ['Invite', 3], ['Leave', 4], ['Send', 5]]);
    const type = root.lookupType(NAMESPACE + 'LegacySubscribeRequest');
    const gameAccountId = entity({ id: GA, program: 'WoW', region: 3 });
    assert.equal(gameAccountId.high.toString(), '144115200966487895');
    const decoded = type.decode(type.encode(type.fromObject({ version: 1, gameAccountId, objectId: '18446744073709551615' })).finish());
    assert.equal(decoded.gameAccountId.low.toString(), GA);
    assert.equal(decoded.objectId.toString(), '18446744073709551615');
});

test('models contain group/session/receipt metadata and no message history', async t => {
    const f = await setup(t);
    assert.equal(define(f.sequelize, DataTypes).SocialLegacyMember, f.models.SocialLegacyMember);
    assert.equal(f.models.SocialLegacyOwner.rawAttributes.generation.type.toSql(), 'BIGINT UNSIGNED');
    assert.deepEqual(f.models.SocialLegacyClaim.primaryKeyAttributes, ['gameAccountId', 'sessionKey']);
    assert.equal(f.models.SocialLegacyMember.rawAttributes.gameAccountId.type.toSql(), 'BIGINT');
    for (const [name, model] of Object.entries(f.models)) {
        if (name.startsWith('SocialLegacy')) { assert.equal(Object.keys(model.rawAttributes).some(key => /text|message|history/i.test(key)), false); }
    }
});

test('every RPC gates 15595 capability, version and selected-license ownership', async t => {
    const f = await setup(t);
    const request = { objectId: '9', first: entity(f.b.game), second: entity(f.c.game),
        target: entity(f.b.game), groupId: '00000000-0000-4000-8000-000000000001', text: 'hello' };
    for (const operation of ['subscribe', 'create', 'invite', 'leave', 'send']) {
        const context = f.context(f.a, request);
        context.owner = { ...context.owner, applicationVersion: 26972 };
        await assert.rejects(f.chat[operation](context), code('LEGACY_UNSUPPORTED_CLIENT'));
        context.owner = f.a.owner; context.request.version = 2;
        await assert.rejects(f.chat[operation](context), code('LEGACY_INVALID_VERSION'));
        context.request.version = 1; context.request.gameAccountId = entity(f.b.game);
        await assert.rejects(f.chat[operation](context), code('LEGACY_NOT_OWNER'));
        context.request.gameAccountId = { ...entity(f.a.game), high: Long.UZERO };
        await assert.rejects(f.chat[operation](context), code('LEGACY_NOT_OWNER'));
    }
});

test('creator friendships authorize admission without requiring all participants to be friends', async t => {
    const f = await setup(t);
    const created = await group(f);
    assert.equal(created.snapshot.groups.length, 1);
    assert.deepEqual(created.snapshot.groups[0].members.map(member => member.gameAccountId.low.toString()), [GA, GB, GC]);
    assert.equal(f.policyReads.filter(value => value === 'friends').length, 2);
    assert.ok(f.policyReads.includes('blocks'));
    for (const transaction of new Set(f.locks.map(lock => lock.transaction))) {
        const locks = f.locks.filter(lock => lock.transaction === transaction).map(lock => lock.id);
        assert.deepEqual(locks, [...locks].sort((a, b) => BigInt(a) < BigInt(b) ? -1 : 1));
    }
    const d = await f.game('800', '80'); await f.subscribe(d); f.friend(B, '80');
    await assert.rejects(f.chat.invite(f.context(f.a, { groupId: created.id, target: entity(d.game) })), code('LEGACY_NOT_FRIENDS'));
    const invited = await f.chat.invite(f.context(f.b, { groupId: created.id, target: entity(d.game) }));
    assert.equal(invited.groups[0].members.length, 4);
});

test('any pair block rejects admission and live sends, with all parent locks held before policy reads', async t => {
    const f = await setup(t);
    await f.models.SocialBlock.create({ accountId: B, blockedId: C });
    await assert.rejects(group(f), code('LEGACY_BLOCKED'));
    assert.equal(await f.models.SocialLegacyGroup.count({ where: {} }), 0);
    await f.models.SocialBlock.destroy({ where: {} });
    const created = await group(f);
    await f.models.SocialBlock.create({ accountId: C, blockedId: B });
    await assert.rejects(f.chat.send(f.context(f.a, { groupId: created.id, text: 'private' })), code('LEGACY_BLOCKED'));
    assert.equal(f.frames.length, 0); assert.equal(f.redis.size, 0);
});

test('distinct concurrent licenses of the same parent remain distinct members', async t => {
    const f = await setup(t);
    const second = await f.game('999', B); await f.subscribe(second);
    const result = await f.chat.create(f.context(f.a, { first: entity(f.b.game), second: entity(second.game) }));
    assert.equal(result.groups[0].members.length, 3);
    assert.deepEqual(result.groups[0].members.filter(member => member.accountId.low.toString() === B)
        .map(member => member.gameAccountId.low.toString()).sort(), [GB, '999'].sort());
});

test('six-group and twelve-member limits roll back complete mutations', async t => {
    const f = await setup(t);
    for (let i = 0; i < LIMITS.groups; ++i) { await group(f); }
    await assert.rejects(group(f), code('LEGACY_CAPACITY'));
    assert.equal(await f.models.SocialLegacyGroup.count({ where: {} }), 6);
    const other = await setup(t), created = await group(other);
    for (let i = 0; i < 10; ++i) {
        const actor = await other.game(String(1000 + i), String(2000 + i));
        await other.subscribe(actor); other.friend(A, actor.accountId);
        const call = other.chat.invite(other.context(other.a, { groupId: created.id, target: entity(actor.game) }));
        if (i < 9) { await call; } else { await assert.rejects(call, code('LEGACY_CAPACITY')); }
    }
    assert.equal((await other.chat.snapshot(other.a.owner, GA, other.a.generation)).groups[0].members.length, 12);
});

test('create/invite/leave receipts deduplicate mutations and reject key reuse with changed input', async t => {
    const f = await setup(t), created = await group(f, 500);
    assert.equal((await f.chat.create(created.context)).affectedGroupId, created.id);
    assert.equal(await f.models.SocialLegacyGroup.count({ where: {} }), 1);
    const changed = f.context(f.a, { first: entity(f.c.game), second: entity(f.b.game) }, 500);
    await assert.rejects(f.chat.create(changed), code('LEGACY_OPERATION_CONFLICT'));
    const leave = f.context(f.c, { groupId: created.id }, 501);
    await f.chat.leave(leave); await f.chat.leave(leave);
    assert.equal(await f.models.SocialLegacyGroup.count({ where: {} }), 0);
    assert.equal(await f.models.SocialLegacyClosed.count({ where: {} }), 2);
    // Retried Create reports current state, not an obsolete stored member list.
    assert.equal((await f.chat.create(created.context)).groups.length, 0);
});

test('closure admission reserves all existing groups and only confirmed reconciliation restores capacity', async t => {
    assert.equal(LIMITS.pendingClosures, 64);
    assert.equal(CLOSURE_SNAPSHOT_CAPACITY, 70);
    const f = await setup(t), active = [];
    for (let i = 0; i < LIMITS.groups; ++i) { active.push((await group(f)).id); }
    const d = await f.game('800', '80'); await f.subscribe(d); f.friend(A, d.accountId);
    const closure = actor => ({ groupId: randomUUID(), gameAccountId: actor.gameId, accountId: actor.accountId,
        sessionKey: actor.owner.sessionKey, generation: actor.generation, peerGameAccountId: GB, peerAccountId: B, createdAt: new Date() });
    for (const actor of [f.a, d]) {
        for (let i = 0; i < LIMITS.pendingClosures; ++i) { await f.models.SocialLegacyClosed.create(closure(actor)); }
    }
    await assert.rejects(f.chat.invite(f.context(f.a, { groupId: active[0], target: entity(d.game) })), code('LEGACY_CAPACITY'));
    assert.equal(await f.models.SocialLegacyMember.count({ where: { gameAccountId: d.gameId } }), 0);
    await f.chat.cleanup();
    assert.equal(await f.models.SocialLegacyClosed.count({ where: { gameAccountId: GA } }), 64, 'no eviction while delivery is unacknowledged');
    for (const groupId of active) { await f.chat.leave(f.context(f.c, { groupId })); }
    const full = await f.chat.snapshot(f.a.owner, GA, f.a.generation);
    assert.equal(full.closed.length, 70, 'all six already admitted groups can close at the admission boundary');
    assert.equal(full.groups.length, 0);
    await assert.rejects(group(f), code('LEGACY_CAPACITY'));
    assert.equal(await f.models.SocialLegacyGroup.count({ where: {} }), 0, 'capacity failure rolls back Create');
    const frames = f.chat.diff({ closed: [] }, full, { objectId: '1' });
    assert.equal(frames.length, 71);
    assert.ok(frames.every(frame => frame.payload.length <= 262144), 'bounded closure batch fits direct route frames');
    assert.equal(frames.at(-1).methodId, 1, 'full snapshot follows every conversion');
    const maximalMember = { ...full.closed[0].remaining, battleTag: 'x'.repeat(1020), online: true, activeCharacter: {
        guid: '340282366920938463463374607431768211455', name: 'n'.repeat(64), realmAddress: 4294967295,
        realmName: 'r'.repeat(128), level: 255, classId: 255, raceId: 255, zoneId: 4294967295, faction: 2
    } };
    const maximal = { ...full,
        groups: Array.from({ length: LIMITS.groups }, () => ({ groupId: randomUUID(),
            members: Array.from({ length: LIMITS.members }, () => maximalMember) })),
        closed: full.closed.map(value => ({ ...value, remaining: { ...value.remaining, battleTag: maximalMember.battleTag } }))
    };
    assert.ok(f.chat.diff({ closed: [] }, maximal, { objectId: '1' }).every(frame => frame.payload.length <= 262144),
        'even simultaneous maximum closure/member metadata cannot stall direct delivery on frame size');
    const overflow = closure(f.a);
    await f.models.SocialLegacyClosed.create(overflow);
    await assert.rejects(f.chat.snapshot(f.a.owner, GA, f.a.generation), code('LEGACY_CAPACITY'));
    assert.equal(await f.models.SocialLegacyClosed.count({ where: { gameAccountId: GA } }), 71, 'oversized data is rejected, never truncated');
    await f.models.SocialLegacyClosed.destroy({ where: { groupId: overflow.groupId, gameAccountId: GA } });
    await f.chat.cleanup();
    assert.equal(await f.models.SocialLegacyClosed.count({ where: { gameAccountId: GA } }), 70, 'rejected/unconfirmed delivery cannot release capacity');
    const subscription = (await f.runtime.recipients(A, 'legacy'))[0];
    await f.runtime.notify(subscription, frames);
    await f.models.SocialSubscription.update({ snapshot: full }, { where: { id: subscription.id } });
    await f.chat.cleanup();
    assert.equal(await f.models.SocialLegacyClosed.count({ where: { gameAccountId: GA } }), 0);
    assert.equal(await f.models.SocialLegacyClosed.count({ where: { gameAccountId: d.gameId } }), 64, 'another session unacknowledged queue stays intact');
    assert.equal((await group(f)).snapshot.groups.length, 1, 'confirmed reconciliation and cleanup unblock admission');
});

test('two remaining members close/free the group and receive peer-specific conversion before snapshot', async t => {
    const f = await setup(t), created = await group(f);
    const before = await f.chat.snapshot(f.a.owner, GA, f.a.generation);
    await f.chat.leave(f.context(f.c, { groupId: created.id }));
    const after = await f.chat.snapshot(f.a.owner, GA, f.a.generation);
    assert.equal(after.groups.length, 0); assert.equal(after.closed[0].remaining.gameAccountId.low.toString(), GB);
    const frames = f.chat.diff(before, after, { objectId: '123' });
    assert.deepEqual(frames.map(frame => frame.methodId), [3, 1]);
    assert.equal(frames[0].objectId, '123');
    assert.deepEqual(f.chat.diff(after, after, { objectId: '123' }).map(frame => frame.methodId), [1]);
    assert.equal(await f.models.SocialLegacyMember.count({ where: {} }), 0);
});

test('subscription generation fences old calls, subscriptions and replayed ownership claims', async t => {
    const f = await setup(t), created = await group(f);
    const replacement = await f.game(GA, A, 'new-connection');
    await f.subscribe(replacement, '99');
    assert.equal(replacement.generation, '2');
    await assert.rejects(f.chat.send(f.context(f.a, { groupId: created.id, text: 'stale' })), code('LEGACY_STALE_SESSION'));
    await assert.rejects(f.subscribe(f.a), code('LEGACY_STALE_SESSION'));
    assert.equal((await f.chat.snapshot(f.a.owner, GA, '1')).groups.length, 0);
    assert.equal((await f.chat.snapshot(replacement.owner, GA, '2')).groups.length, 0);
    assert.equal((await f.chat.snapshot(f.b.owner, GB, '1')).closed.length, 1);
    await f.subscribe(replacement, '100');
    assert.equal(replacement.generation, '2', 'same-session recovery keeps generation');
});

test('social worker outage preserves SQL membership; expiry/logout and bans end only the matching owner', async t => {
    const f = await setup(t); await group(f);
    f.runtime.currentFailure = true;
    await assert.rejects(f.chat.cleanup(), /temporarily unavailable/);
    assert.equal(await f.models.SocialLegacyMember.count({ where: {} }), 3);
    f.runtime.currentFailure = false;
    const restarted = new (require('../social/legacy-chat').LegacyChat)(f.runtime, { worldPresence: f.chat.worldPresence });
    assert.equal((await restarted.snapshot(f.a.owner, GA, '1')).groups.length, 1);
    f.sessions.delete(f.c.owner.connectionId);
    await restarted.cleanup();
    assert.equal(await f.models.SocialLegacyMember.count({ where: {} }), 0);
    assert.equal((await f.models.SocialLegacyOwner.findByPk(GC, { raw: true })).active, false);
    const g = await setup(t); await group(g);
    await g.models.GameAccount.update({ isBanned: true }, { where: { id: GC } });
    await g.chat.cleanup();
    assert.equal(await g.models.SocialLegacyMember.count({ where: {} }), 0);
});

test('live text is delivered once to current object IDs; metadata dedup stores no message text', async t => {
    const f = await setup(t), created = await group(f);
    const context = f.context(f.a, { groupId: created.id, text: 'live-only secret' }, 800);
    await f.chat.send(context); await f.chat.send(context);
    assert.equal(f.frames.length, 3);
    const type = loadProto(FILE).lookupType(NAMESPACE + 'LegacyMessage');
    for (const frame of f.frames) {
        const message = type.decode(frame.payload);
        assert.equal(frame.methodId, 2); assert.equal(message.text, 'live-only secret');
        assert.equal(message.sender.gameAccountId.low.toString(), GA);
    }
    assert.equal(JSON.stringify([...f.redis]).includes('live-only secret'), false);
    for (const rows of f.tables().values()) { assert.equal(JSON.stringify([...rows]).includes('live-only secret'), false); }
    await assert.rejects(f.chat.send(f.context(f.a, { groupId: created.id, text: 'changed' }, 800)), code('LEGACY_OPERATION_CONFLICT'));
    f.sessions.delete(f.b.owner.connectionId);
    await assert.rejects(f.chat.send(f.context(f.a, { groupId: created.id, text: 'no offline queue' })), code('LEGACY_OFFLINE'));
    assert.equal(f.frames.length, 3);
});

test('uncertain delivery is never automatically resent, including duplicate RPCs', async t => {
    const f = await setup(t), created = await group(f);
    const context = f.context(f.a, { groupId: created.id, text: 'uncertain' }, 801);
    f.runtime.notificationFailure = true;
    await assert.rejects(f.chat.send(context), code('LEGACY_SEND_UNCONFIRMED'));
    f.runtime.notificationFailure = false;
    await assert.rejects(f.chat.send(context), code('LEGACY_SEND_UNCONFIRMED'));
    assert.equal(f.frames.length, 0);
    assert.equal([...f.redis.values()][0].until, 1000000 + LIMITS.dedupSeconds * 1000);
});

test('service adapter preserves custom errors and marks this service unavailable to stock world routing', async t => {
    const f = await setup(t);
    const service = new Service({ logger: { error() {}, debug() {} }, legacyChat: f.chat });
    assert.equal(service.legacyOnly, true);
    const type = service.rootNamespace.lookupType(NAMESPACE + 'LegacySubscribeRequest');
    const request = type.encode(type.fromObject({ version: 1, gameAccountId: entity(f.a.game), objectId: '9' })).finish();
    const context = { owner: { ...f.a.owner, applicationVersion: 26972 }, header: { serviceHash: service.getServiceHash(), methodId: 1, token: 1 } };
    const result = await service.handleCall(context, request);
    const length = result.readUInt16BE();
    const Header = loadProto('proto/bgs/low/pb/client/rpc_types.proto').lookupType('bgs.protocol.Header');
    assert.equal(Header.decode(result.subarray(2, 2 + length)).status, STATUS.LEGACY_UNSUPPORTED_CLIENT);
});

test('co-members receive BattleTag and fenced active-character data without Real ID or friendship grants', async t => {
    const f = await setup(t), created = await group(f);
    const published = { owner: { account_id: C, game_account_id: GC }, sequence: '1', character: {
        guid: '340282366920938463463374607431768211455', name: 'Current', realm_address: 50397185,
        realm_name: 'Realm', level: 85, class: 8, race: 1, zone: 12, faction: 0
    } };
    f.characters.set(GC, published);
    const read = async () => (await f.chat.snapshot(f.b.owner, GB, f.b.generation)).groups[0].members.find(member => member.gameAccountId.low.toString() === GC);
    const projection = await read();
    assert.equal(projection.battleTag, 'Player#' + C);
    assert.equal(projection.online, true);
    assert.equal(projection.activeCharacter.guid, published.character.guid);
    assert.equal(projection.activeCharacter.classId, 8);
    assert.equal(JSON.stringify(projection).includes('Private'), false);
    assert.equal(JSON.stringify(projection).includes('Person'), false);
    const type = loadProto(FILE).lookupType(NAMESPACE + 'LegacyMember');
    const decoded = type.decode(type.encode(type.fromObject(projection)).finish());
    assert.equal(decoded.activeCharacter.guid, published.character.guid);
    assert.equal(decoded.battleTag, projection.battleTag);
    // Character switching changes only public projection, never membership.
    published.character.name = 'Changed'; published.sequence = '2';
    assert.equal((await read()).activeCharacter.name, 'Changed');
    assert.equal(await f.models.SocialLegacyMember.count({ where: {} }), 3);
    // A publication for another account, even with the selected game ID, is unusable.
    published.owner.account_id = A;
    assert.equal((await read()).activeCharacter, undefined);
    published.owner.account_id = C;
    await f.models.SocialBlock.create({ accountId: B, blockedId: C });
    assert.equal((await read()).activeCharacter, undefined);
    assert.equal((await read()).online, false);
    await f.models.SocialBlock.destroy({ where: {} });
    await f.chat.leave(f.context(f.a, { groupId: created.id }));
    const closed = (await f.chat.snapshot(f.b.owner, GB, f.b.generation)).closed[0].remaining;
    assert.equal(closed.battleTag, projection.battleTag);
    assert.equal(closed.activeCharacter, undefined);
    assert.equal(closed.online, undefined);
    assert.equal((await f.chat.snapshot(f.b.owner, GB, f.b.generation)).groups.length, 0);
});

test('cleanup prunes only closures already recorded in a confirmed subscription snapshot', async t => {
    const f = await setup(t), created = await group(f);
    await f.chat.leave(f.context(f.c, { groupId: created.id }));
    await f.chat.cleanup();
    assert.equal(await f.models.SocialLegacyClosed.count({ where: {} }), 2);
    const snapshot = await f.chat.snapshot(f.a.owner, GA, f.a.generation);
    await f.models.SocialSubscription.update({ snapshot }, { where: { accountId: A } });
    await f.chat.cleanup();
    assert.equal(await f.models.SocialLegacyClosed.count({ where: { accountId: A } }), 0);
    assert.equal(await f.models.SocialLegacyClosed.count({ where: { accountId: B } }), 1);
});

test('an already selected license cannot be replaced by cloning another owned game into the actor', async t => {
    const f = await setup(t), another = await f.game('9007199254741099', A);
    const request = { gameAccountId: entity(another.game), objectId: '1' };
    await assert.rejects(f.chat.subscribe(f.context(f.a, request)), code('LEGACY_NOT_OWNER'));
    assert.equal(f.a.owner.gameAccountId, GA);
    assert.equal(await f.models.SocialLegacyOwner.findByPk(another.gameId), null);
});

test('participating session blocks gate group admission and sends without ending membership', async t => {
    const f = await setup(t);
    f.sessionBlocks.add(f.b.owner.sessionKey + ':' + C);
    await assert.rejects(group(f), code('LEGACY_BLOCKED'));
    assert.equal(await f.models.SocialLegacyGroup.count({ where: {} }), 0);
    f.sessionBlocks.clear();
    const created = await group(f), d = await f.game('9007199254741099', '9007199254741097');
    await f.subscribe(d); f.friend(A, d.accountId);
    f.sessionBlocks.add(d.owner.sessionKey + ':' + B);
    await assert.rejects(f.chat.invite(f.context(f.a, { groupId: created.id, target: entity(d.game) })), code('LEGACY_BLOCKED'));
    f.sessionBlocks.clear(); f.sessionBlocks.add(f.b.owner.sessionKey + ':' + C);
    await assert.rejects(f.chat.send(f.context(f.a, { groupId: created.id, text: 'blocked' })), code('LEGACY_BLOCKED'));
    assert.equal(f.frames.length, 0); assert.equal(f.redis.size, 0);
    await f.chat.cleanup();
    assert.equal(await f.models.SocialLegacyMember.count({ where: {} }), 3);
    f.sessionBlocks.clear();
    await f.chat.send(f.context(f.a, { groupId: created.id, text: 'allowed' }));
    assert.equal(f.frames.length, 3);
});
