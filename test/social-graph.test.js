'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { DataTypes } = require('sequelize');
const { fixture } = require('./support/social-graph-fixture');
const define = require('../models/socialgraph');
const { SocialGraph, LIMITS } = require('../social/graph');
const SocialRuntime = require('../social/runtime');

const A = '9007199254740993';
const B = '9007199254740995';
const C = '9223372036854775807';
const error = code => value => value.code === code;

async function setup(t, options) {
    const f = fixture(options);
    t.after(() => f.sequelize.close());
    await f.account(A); await f.account(B); await f.account(C);
    return f;
}

async function friends(graph, actorId = A, targetId = B, kind = 'battle_tag', key = 'friend') {
    const invitation = await graph.invite({ actorId, targetId, kind, operationId: `${key}:invite` });
    await graph.accept({ actorId: targetId, targetId: actorId, invitationId: invitation.invitationId, operationId: `${key}:accept` });
    return invitation;
}

test('model factory preserves signed parent IDs, unsigned counters, directional keys and registry identity', async t => {
    const f = await setup(t);
    assert.equal(f.models.SocialFriendship.getTableName(), 'social_friendships');
    assert.equal(f.models.SocialFriendship.rawAttributes.lowId.field, 'low_id');
    assert.equal(f.models.SocialFriendship.rawAttributes.lowId.type.toSql(), 'BIGINT');
    assert.equal(f.models.SocialInvitation.rawAttributes.id.type.toSql(), 'BIGINT UNSIGNED');
    assert.equal(f.models.SocialRevision.rawAttributes.revision.type.toSql(), 'BIGINT UNSIGNED');
    assert.deepEqual(f.models.SocialNote.primaryKeyAttributes, ['accountId', 'friendId']);
    assert.deepEqual(f.models.SocialMutation.primaryKeyAttributes, ['accountId', 'operationId']);
    assert.equal(define(f.sequelize, DataTypes).SocialOutbox, f.models.SocialOutbox);
});

test('canonical IDs reject unsafe numbers, aliases, unsigned account overflow and self-targeting', async t => {
    const { graph } = await setup(t);
    for (const actorId of [9007199254740992, 1, 1n, '01', '0', '+1', '-1', '1e3', '9223372036854775808']) {
        await assert.rejects(graph.invite({ actorId, targetId: B, kind: 'battle_tag', operationId: 'x' }), error('INVALID_ID'));
    }
    await assert.rejects(graph.invite({ actorId: A, targetId: A, kind: 'battle_tag', operationId: 'x' }), error('SELF_TARGET'));
    await assert.rejects(graph.invite({ actorId: A, targetId: B, kind: 1, operationId: 'x' }), error('INVALID_KIND'));
    await assert.rejects(graph.invite({ actorId: A, targetId: B, kind: 'battle_tag', operationId: '' }), error('INVALID_OPERATION_ID'));
});

test('BattleTag friendship and pending Real ID requests never disclose names, despite both opting in', async t => {
    const { graph, Account } = await setup(t);
    await Account.update({ realIdEnabled: true }, { where: {} });
    await friends(graph);
    const snapshot = await graph.snapshot(A);
    assert.equal(snapshot.revision, '2');
    assert.deepEqual(snapshot.friends[0], { accountId: B, battleTag: `Player#${B}`, kind: 'battle_tag',
        givenName: '', surname: '', realIdVisible: false, note: '' });
    const upgrade = await graph.invite({ actorId: A, targetId: B, kind: 'real_id', operationId: 'upgrade' });
    const pending = (await graph.snapshot(B)).receivedInvitations[0];
    assert.equal(pending.invitationId, upgrade.invitationId);
    assert.equal(pending.peer.givenName, '');
    assert.equal(pending.peer.surname, '');
    assert.equal(pending.peer.kind, null);
    assert.equal((await graph.project(A, B)).realIdVisible, false);
    const events = JSON.stringify(await graph.pendingOutbox());
    assert.equal(events.includes('Private'), false);
    assert.equal(events.includes('Person'), false);
    assert.equal(events.includes('Player#'), false);
});

test('Real ID requires both opt-ins at invitation and acceptance, and privacy is rechecked at projection time', async t => {
    const { graph, Account } = await setup(t);
    const input = { actorId: A, targetId: B, kind: 'real_id', operationId: 'invite-rid' };
    await assert.rejects(graph.invite(input), error('REAL_ID_DISABLED'));
    await Account.update({ realIdEnabled: true }, { where: {} });
    const { invitationId } = await graph.invite(input);
    await Account.update({ realIdEnabled: false }, { where: { id: B } });
    await assert.rejects(graph.accept({ actorId: B, targetId: A, invitationId, operationId: 'accept-rid' }), error('REAL_ID_DISABLED'));
    await Account.update({ realIdEnabled: true }, { where: { id: B } });
    await graph.accept({ actorId: B, targetId: A, invitationId, operationId: 'accept-rid' });
    assert.equal((await graph.project(A, B)).givenName, 'Private');
    assert.equal((await graph.access(A, B)).canSeeRealName, true);
    await Account.update({ realIdEnabled: false }, { where: { id: A } });
    for (const [viewer, target] of [[A, B], [B, A]]) {
        const projected = await graph.project(viewer, target);
        assert.equal(projected.givenName, ''); assert.equal(projected.surname, '');
        assert.equal(projected.realIdVisible, false);
        assert.equal((await graph.snapshot(viewer)).friends[0].givenName, '');
    }
});

test('Real ID upgrades require explicit acceptance and cannot be downgraded by a BattleTag invite', async t => {
    const { graph, Account } = await setup(t);
    await friends(graph);
    await Account.update({ realIdEnabled: true }, { where: {} });
    const upgrade = await graph.invite({ actorId: A, targetId: B, kind: 'real_id', operationId: 'upgrade' });
    assert.equal((await graph.access(A, B)).kind, 'battle_tag');
    await graph.accept({ actorId: B, targetId: A, operationId: 'upgrade-accept', invitationId: upgrade.invitationId });
    assert.equal((await graph.access(A, B)).kind, 'real_id');
    const again = await graph.invite({ actorId: B, targetId: A, kind: 'battle_tag', operationId: 'downgrade' });
    assert.equal(again.changed, false);
    assert.equal(again.kind, 'real_id');
});

test('64-bit revisions and IDs survive receipts, SQL JSON representation, retry and outbox recovery', async t => {
    const { graph, models } = await setup(t);
    await models.SocialRevision.create({ accountId: A, revision: '9007199254740999' });
    const input = { actorId: A, targetId: B, kind: 'battle_tag', operationId: 'retry' };
    const result = await graph.invite(input);
    assert.equal(result.revisions[A], '9007199254741000');
    assert.equal(result.invitationId, '9007199254740993');
    assert.deepEqual(await graph.invite(input), result);
    await models.SocialMutation.update({ result: JSON.stringify(result) }, { where: { accountId: A, operationId: 'retry' } });
    assert.deepEqual(await graph.invite(input), result);
    await assert.rejects(graph.invite({ ...input, message: 'changed' }), error('OPERATION_CONFLICT'));
    assert.equal((await graph.pendingOutbox()).length, 2);
    const events = await graph.pendingOutbox(1);
    assert.equal(events[0].revision, '9007199254741000');
    assert.equal(await graph.acknowledgeOutbox(events), 1);
    assert.equal(await graph.acknowledgeOutbox(events), 0);
    assert.equal((await graph.pendingOutbox()).length, 1);
    assert.equal((await graph.snapshot(A)).revision, '9007199254741000');
    await graph.revoke({ actorId: A, targetId: B, invitationId: result.invitationId, operationId: 'revoke' });
    assert.deepEqual(await graph.invite(input), result);
    assert.equal((await graph.snapshot(A)).sentInvitations.length, 0);
});

test('only the invitation recipient can accept or decline; only its sender can revoke', async t => {
    const { graph } = await setup(t);
    const input = { actorId: A, targetId: B, kind: 'battle_tag', operationId: 'invite' };
    const { invitationId } = await graph.invite(input);
    const reverse = await graph.invite({ actorId: B, targetId: A, kind: 'battle_tag', operationId: 'reciprocal' });
    assert.equal(reverse.changed, false);
    assert.equal(reverse.invitationId, invitationId);
    assert.equal((await graph.access(A, B)).friends, false);
    await assert.rejects(graph.accept({ actorId: A, targetId: B, invitationId, operationId: 'wrong' }), error('INVITATION_NOT_RECIPIENT'));
    await assert.rejects(graph.decline({ actorId: A, targetId: B, invitationId, operationId: 'wrong' }), error('INVITATION_NOT_OWNER'));
    await assert.rejects(graph.revoke({ actorId: B, targetId: A, invitationId, operationId: 'wrong' }), error('INVITATION_NOT_OWNER'));
    await graph.decline({ actorId: B, targetId: A, invitationId, operationId: 'decline' });
    const next = await graph.invite({ ...input, operationId: 'new-invite' });
    assert.notEqual(next.invitationId, invitationId);
    await assert.rejects(graph.revoke({ actorId: A, targetId: B, invitationId, operationId: 'stale' }), error('INVITATION_CONFLICT'));
});

test('notes are directional, emit only an owner event, and are cleared when the friendship ends', async t => {
    const { graph } = await setup(t);
    await friends(graph);
    const before = (await graph.snapshot(B)).revision;
    await graph.setNote({ actorId: A, targetId: B, operationId: 'note', note: 'Only for A' });
    assert.equal((await graph.project(A, B)).note, 'Only for A');
    assert.equal((await graph.project(B, A)).note, '');
    assert.equal((await graph.snapshot(B)).revision, before);
    assert.equal(JSON.stringify(await graph.pendingOutbox()).includes('Only for A'), false);
    const noop = await graph.setNote({ actorId: A, targetId: B, operationId: 'same-note', note: 'Only for A' });
    assert.equal(noop.changed, false);
    await graph.remove({ actorId: B, targetId: A, operationId: 'remove' });
    await friends(graph, A, B, 'battle_tag', 'again');
    assert.equal((await graph.project(A, B)).note, '');
});

test('blocks cancel both relationship directions, notes and invites and deny access both ways', async t => {
    const { graph, Account } = await setup(t);
    await friends(graph);
    await Account.update({ realIdEnabled: true }, { where: {} });
    await graph.invite({ actorId: A, targetId: B, operationId: 'upgrade', kind: 'real_id' });
    await graph.setNote({ actorId: A, targetId: B, operationId: 'note', note: 'private' });
    await graph.block({ actorId: B, targetId: A, operationId: 'block' });
    for (const [viewer, target] of [[A, B], [B, A]]) {
        assert.equal((await graph.access(viewer, target)).blocked, true);
        await assert.rejects(graph.assertAccess(viewer, target, 'whisper'), error('BLOCKED'));
        await assert.rejects(graph.invite({ actorId: viewer, targetId: target, operationId: 'blocked-invite', kind: 'battle_tag' }), error('BLOCKED'));
        assert.equal(await graph.project(viewer, target), null);
        const snapshot = await graph.snapshot(viewer);
        assert.equal(snapshot.friends.length + snapshot.sentInvitations.length + snapshot.receivedInvitations.length, 0);
    }
    assert.deepEqual((await graph.snapshot(A)).blocks, []);
    assert.equal((await graph.snapshot(B)).blocks[0].accountId, A);
    await graph.unblock({ actorId: B, targetId: A, operationId: 'unblock' });
    assert.equal((await graph.access(A, B)).friends, false);
    assert.equal((await graph.access(A, B)).blocked, false);
});

test('outbox failure or pending-event cap rolls back graph rows, revisions and retry receipts together', async t => {
    const f = await setup(t, { limits: { pendingEvents: 1 } });
    const input = { actorId: A, targetId: B, operationId: 'invite', kind: 'battle_tag' };
    f.failOutbox(true);
    await assert.rejects(f.graph.invite(input), /Injected outbox failure/);
    assert.equal((await f.graph.snapshot(A)).revision, '0');
    assert.equal(f.tables.get('SocialMutation').size, 0);
    assert.equal(f.tables.get('SocialInvitation').size, 0);
    f.failOutbox(false);
    const invitation = await f.graph.invite(input);
    const accept = { actorId: B, targetId: A, invitationId: invitation.invitationId, operationId: 'accept' };
    await assert.rejects(f.graph.accept(accept), error('OUTBOX_FULL'));
    assert.equal((await f.graph.snapshot(A)).sentInvitations.length, 1);
    assert.equal((await f.graph.snapshot(A)).friends.length, 0);
    assert.equal((await f.graph.snapshot(A)).revision, '1');
    await f.graph.acknowledgeOutbox(await f.graph.pendingOutbox());
    assert.equal((await f.graph.accept(accept)).changed, true);
});

test('concurrent accept and block serialize with numeric account order and cannot leave a blocked friendship', async t => {
    const { graph, lockTrace } = await setup(t);
    const invitation = await graph.invite({ actorId: A, targetId: B, operationId: 'invite', kind: 'battle_tag' });
    const results = await Promise.allSettled([
        graph.block({ actorId: A, targetId: B, operationId: 'block' }),
        graph.accept({ actorId: B, targetId: A, invitationId: invitation.invitationId, operationId: 'accept' })
    ]);
    assert.equal(results[0].status, 'fulfilled');
    assert.equal(results[1].status, 'rejected');
    assert.equal(results[1].reason.code, 'BLOCKED');
    assert.equal((await graph.snapshot(A)).friends.length, 0);
    assert.equal((await graph.snapshot(B)).receivedInvitations.length, 0);
    for (let i = 0; i < lockTrace.length; i += 2) {
        assert.deepEqual(lockTrace.slice(i, i + 2).map(row => row.id), [A, B]);
    }
});

test('concurrent invitations share a cap and reciprocal requests retain one pending pair', async t => {
    const { graph } = await setup(t, { limits: { invitations: 1 } });
    const results = await Promise.allSettled([B, C].map(targetId => graph.invite({ actorId: A, targetId,
        operationId: `invite:${targetId}`, kind: 'battle_tag' })));
    assert.equal(results.filter(row => row.status === 'fulfilled').length, 1);
    assert.equal(results.find(row => row.status === 'rejected').reason.code, 'INVITATION_LIMIT');
    assert.equal((await graph.snapshot(A)).sentInvitations.length, 1);
});

test('friend and block caps are bounded, and snapshot list queries always have finite limits', async t => {
    const { graph, queries } = await setup(t, { limits: { friends: 1, blocks: 1 } });
    await friends(graph);
    await assert.rejects(graph.invite({ actorId: A, targetId: C, operationId: 'full', kind: 'battle_tag' }), error('FRIEND_LIMIT'));
    await graph.block({ actorId: A, targetId: B, operationId: 'block' });
    await assert.rejects(graph.block({ actorId: A, targetId: C, operationId: 'full-block' }), error('BLOCK_LIMIT'));
    queries.length = 0;
    await graph.snapshot(A);
    assert.ok(queries.length > 0);
    assert.ok(queries.every(({ query }) => Number.isSafeInteger(query.limit) && query.limit > 0));
});

test('native block capacity is a hard 100-target union across durable and every parent session', async t => {
    const f = await setup(t);
    assert.equal(LIMITS.blocks, 100); assert.equal(LIMITS.friends, 200); assert.equal(LIMITS.invitations, 100);
    assert.throws(() => new SocialGraph({ sequelize: f.sequelize, Account: f.Account, models: f.models, limits: { blocks: 101 } }), error('INVALID_LIMIT'));
    for (let i = 0; i < 100; ++i) {
        const targetId = i === 99 ? B : String(1000 + i);
        // More than 101 rows, but exactly 100 distinct targets. Group before LIMIT, not afterward.
        for (const sessionKey of ['c:one', 'c:two']) {
            await f.models.SocialSessionBlock.create({ id: sessionKey + ':' + i, accountId: A, blockedAccountId: targetId,
                sessionKey, route: { type: 'connection', connectionId: sessionKey.slice(2) }, createdAt: new Date() });
        }
    }
    await assert.rejects(f.graph.block({ actorId: A, targetId: C, operationId: 'new' }), error('BLOCK_LIMIT'));
    // Moving an already counted session target into the durable list consumes no new slot.
    assert.equal((await f.graph.block({ actorId: A, targetId: B, operationId: 'existing' })).changed, true);
    const runtime = new SocialRuntime({ models: { ...f.models, Account: f.Account, sequelize: f.sequelize } });
    runtime.current = async () => ({ accountId: A, sessionKey: 'c:three' });
    const owner = { accountId: A, sessionKey: 'c:three', route: { type: 'connection', connectionId: 'three' } };
    assert.equal(await runtime.blockSession(owner, B), true);
    assert.equal(await runtime.blockSession(owner, B), false);
    await assert.rejects(runtime.blockSession(owner, C), value => value === 0x1F45);
    // Cleanup is deliberately independent: expired rows count conservatively until removed.
    await f.graph.unblock({ actorId: A, targetId: B, operationId: 'remove-durable' });
    await assert.rejects(f.graph.block({ actorId: A, targetId: C, operationId: 'new-again' }), error('BLOCK_LIMIT'));
    const queries = f.queries.filter(({ query }) => query.group);
    assert.ok(queries.length > 0);
    assert.ok(queries.every(({ query }) => query.where.accountId === A && query.limit === 101));
});

test('durable and session block races share the parent lock across licenses and leave at most 100 targets', async t => {
    for (const sessionFirst of [false, true]) {
        const f = await setup(t);
        for (let i = 0; i < 99; ++i) {
            const blockedId = String(1000 + i);
            await f.account(blockedId);
            if (i % 2) { await f.models.SocialBlock.create({ accountId: A, blockedId, createdAt: new Date() }); }
            else {
                await f.models.SocialSessionBlock.create({ id: 'old:' + i, sessionKey: 'c:old-license', accountId: A,
                    blockedAccountId: blockedId, route: {}, createdAt: new Date() });
            }
        }
        const runtime = new SocialRuntime({ models: { ...f.models, Account: f.Account, sequelize: f.sequelize } });
        runtime.current = async () => ({ accountId: A, sessionKey: 'c:new-license' });
        const owner = { accountId: A, sessionKey: 'c:new-license', route: {} };
        const durable = () => f.graph.block({ actorId: A, targetId: B, operationId: 'race' });
        const session = () => runtime.blockSession(owner, C);
        const results = await Promise.allSettled((sessionFirst ? [session, durable] : [durable, session]).map(run => run()));
        assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
        const rejected = results.find(result => result.status === 'rejected').reason;
        assert.ok(rejected === 0x1F45 || rejected.code === 'BLOCK_LIMIT');
        const permanent = await f.models.SocialBlock.findAll({ where: { accountId: A }, raw: true });
        const temporary = await f.models.SocialSessionBlock.findAll({ where: { accountId: A }, raw: true });
        assert.equal(new Set([...permanent.map(row => row.blockedId), ...temporary.map(row => row.blockedAccountId)]).size, 100);
        const won = permanent.some(row => row.blockedId === B);
        assert.equal((await f.graph.snapshot(A)).revision, won ? '1' : '0');
        assert.equal((await f.models.SocialMutation.findAll({ raw: true })).length, won ? 1 : 0);
        assert.ok(f.lockTrace.filter(row => row.id === A).length >= 2);
    }
});

test('reporter identity is supplied by the authenticated adapter, reports are private and rate/size limited', async t => {
    const { graph, models } = await setup(t, { limits: { reportsPerDay: 1 } });
    const input = { actorId: A, targetId: B, operationId: 'report', reason: 'spam', details: 'message context', reporterId: C };
    const result = await graph.report(input);
    assert.equal(result.reportId, '9007199254740993');
    assert.equal((await models.SocialReport.findOne({ where: { id: result.reportId }, raw: true })).reporterId, A);
    assert.deepEqual(await graph.report(input), result);
    await assert.rejects(graph.report({ ...input, operationId: 'second' }), error('REPORT_LIMIT'));
    await assert.rejects(graph.report({ ...input, details: 'é'.repeat(2049) }), error('INVALID_REPORT'));
    await assert.rejects(graph.report({ ...input, reason: '' }), error('INVALID_REPORT'));
    assert.equal((await graph.snapshot(B)).revision, '0');
    assert.equal(JSON.stringify(await graph.pendingOutbox()).includes('message context'), false);
});

test('byte lengths, invalid Unicode, invalid limits and exhausted revision fail closed', async t => {
    const f = await setup(t);
    for (const message of ['é'.repeat(513), '\ud800', 'a\0b']) {
        await assert.rejects(f.graph.invite({ actorId: A, targetId: B, operationId: 'x', kind: 'battle_tag', message }), error('INVALID_MESSAGE'));
    }
    assert.throws(() => new SocialGraph({ sequelize: f.sequelize, Account: f.Account, models: f.models, limits: { friends: Infinity } }), error('INVALID_LIMIT'));
    await assert.rejects(f.graph.pendingOutbox(201), error('INVALID_LIMIT'));
    await assert.rejects(f.graph.acknowledgeOutbox([]), error('INVALID_LIMIT'));
    await f.models.SocialRevision.create({ accountId: A, revision: '18446744073709551615' });
    await assert.rejects(f.graph.block({ actorId: A, targetId: B, operationId: 'overflow' }), error('REVISION_EXHAUSTED'));
    assert.equal((await f.graph.snapshot(A)).blocks.length, 0);
});

test('migration is additive, executes all DDL and refuses destructive rollback', async () => {
    const migration = require('../migrations/20261112000002-social-graph');
    const queries = [];
    await migration.up({ sequelize: { query: async statement => queries.push(statement) } });
    assert.equal(queries.length, 8);
    assert.ok(queries.every(statement => statement.startsWith('CREATE TABLE IF NOT EXISTS social_')));
    await assert.rejects(migration.down(), /additive/);
});
