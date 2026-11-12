'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const Long = require('long');
const { createHash } = require('node:crypto');
const FriendsService = require('../services/friends');
const UserManagerService = require('../services/user_manager');
const ReportService = require('../services/report');
const wire = require('../social/wire');
const friendsWire = require('../social/friends-wire');
const { SocialError } = require('../social/errors');
const { fakeSession } = require('./support/social-session');
const { fixture } = require('./support/social-graph-fixture');

const A = '9007199254740993';
const B = '9007199254740995';
const C = '9007199254740997';
const INVITE = '18446744073709551614';
const OBJECT = '18446744073709551615';
const Header = wire.type('rpc_types', 'bgs.protocol.Header');
const empty = accountId => ({ accountId, revision: '0', friends: [], receivedInvitations: [], sentInvitations: [], blocks: [] });
const profile = (accountId = B, kind = 'battle_tag') => ({ accountId, battleTag: 'Friend#1234', kind,
    fullName: kind === 'real_id' ? 'Private Name' : '', realIdVisible: kind === 'real_id', note: 'owner-only note' });
const invitation = (senderId = B, recipientId = A, kind = 'real_id') => ({ invitationId: INVITE, senderId, recipientId, kind,
    message: 'hello', createdAt: new Date(), peer: profile(senderId === A ? recipientId : senderId, kind) });

function setup() {
    const state = empty(A);
    const calls = [];
    const queries = [];
    const registrations = new Map();
    const sessionBlocks = new Map();
    const owner = { accountId: A, applicationVersion: 26972, gameAccountId: '7', sessionKey: 'session' };
    const high = Long.fromBits(0x576F57, 0x02000001, true);
    const games = new Map([
        ['7', { id: '7', accountId: A, region: 1, entityId: { high, low: Long.fromString('7', true) } }],
        ['9', { id: '9', accountId: B, region: 1, entityId: { high, low: Long.fromString('9', true) } }],
        ['10', { id: '10', accountId: A, region: 1, entityId: { high, low: Long.fromString('10', true) } }]
    ]);
    const rows = { invitation: null, receipt: null, accounts: [{ id: B }] };
    const models = {
        Account: { findAll: async query => { queries.push(query); return rows.accounts; } },
        SocialInvitation: { findOne: async query => { queries.push(query); return rows.invitation; } },
        SocialMutation: { findOne: async query => { queries.push(query); return rows.receipt; } },
        GameAccount: { findByPk: async id => games.get(id) || null },
        sequelize: { query: async (sql, options) => { queries.push({ sql, ...options }); return rows.accounts; } }
    };
    const graph = {
        limits: { friends: 200, invitations: 100 }, snapshot: async id => {
            calls.push(['snapshot', id]); assert.equal(id, A); return structuredClone(state);
        },
        assertAccess: async (actorId, targetId, action) => { calls.push(['access', actorId, targetId, action]); return {}; }
    };
    for (const method of ['invite', 'accept', 'revoke', 'decline', 'remove', 'setNote', 'block', 'unblock', 'report']) {
        graph[method] = async input => { calls.push([method, input]); return { changed: true, revisions: { [A]: '1', [B]: '1' } }; };
    }
    // Session blocks are kept per session key so another license's session stays independent.
    const session = (data = owner, context = null) => fakeSession(data, { context, calls, methods: current => ({
        operationId: () => createHash('sha256').update(context?.operation || 'operation').digest('hex'),
        sessionBlocks: async () => [...(sessionBlocks.get(current.sessionKey) || [])].map(accountId => ({ accountId, battleTag: 'Session#1234' })),
        blockForSession: async accountId => {
            calls.push(['blockForSession', current.sessionKey, accountId]);
            if (!sessionBlocks.has(current.sessionKey)) { sessionBlocks.set(current.sessionKey, new Set()); }
            sessionBlocks.get(current.sessionKey).add(accountId);
            return true;
        },
        unblockForSession: async accountId => sessionBlocks.get(current.sessionKey)?.delete(accountId) || false
    }) });
    const runtime = {
        graph,
        session: async context => { if (context.identity?.sessionKey !== owner.sessionKey) { throw 0xA; } return session(owner, context); },
        register: (kind, hooks) => registrations.set(kind, hooks),
        reconcile: async accountId => calls.push(['reconcile', accountId])
    };
    const deps = { models, runtime, logger: { error() {}, debug() {} } };
    return { owner, session, models, runtime, state, calls, queries, registrations, rows, games, graph,
        friends: new FriendsService(deps), blocks: new UserManagerService(deps), reports: new ReportService(deps) };
}

async function rpc(service, name, data = {}, extras = {}) {
    const method = service.methods.find(value => value.name === name);
    const request = service.rootNamespace.lookupType(method.requestType);
    const payload = request.encode(request.fromObject(data)).finish();
    const context = { identity: { sessionKey: 'session' }, header: { serviceId: 0, methodId: method.getOption('(bgs.protocol.method_options).id'),
        token: 17, objectId: Long.fromString(OBJECT, true) }, ...extras };
    const frame = await service.handleCall(context, payload);
    const length = frame.readUInt16BE(0);
    const header = Header.decode(frame.subarray(2, length + 2));
    const response = service.rootNamespace.lookupType(method.responseType).decode(frame.subarray(length + 2));
    return { header, response, status: header.status, context };
}

function sendParameters(fields, message = '') {
    return { targetId: { high: '0', low: '0' }, params: { invitationMessage: message, [friendsWire.PARAMS]: fields } };
}

function decodeCallback(frame, file, listener) {
    const root = wire.root(file);
    const method = root.lookupService(listener).methodsArray.find(value => value.getOption('(bgs.protocol.method_options).id') === frame.methodId);
    return { method: method.name, data: root.lookupType(method.requestType).decode(frame.payload) };
}

test('Subscribe advertises recovered role names, keeps uint64 object/invitation IDs, and seeds runtime snapshot', async () => {
    const f = setup();
    f.state.friends = [profile()];
    f.state.receivedInvitations = [invitation()];
    const result = await rpc(f.friends, 'Subscribe', { agentId: wire.account(A), objectId: OBJECT });
    assert.equal(result.status, 0);
    assert.equal(result.header.objectId.toString(), OBJECT);
    assert.deepEqual(result.response.role.map(value => [value.id, value.name]), [[1, 'battle_tag_friend'], [2, 'real_id_friend']]);
    assert.equal(result.response.friends[0].accountId.low.toString(), B);
    assert.equal(result.response.friends[0].attribute[0].name, 'friend_note');
    assert.equal(result.response.receivedInvitations[0].id.toString(), INVITE);
    assert.deepEqual(result.response.receivedInvitations[0][friendsWire.INVITATION].role, [2]);
    assert.equal(result.response.receivedInvitations[0].inviterName, 'Friend#1234');
    assert.equal(JSON.stringify(result.response).includes('Private'), false);
    const subscribed = f.calls.find(call => call[0] === 'subscribe');
    assert.equal(subscribed[1], 'friends'); assert.equal(subscribed[2], A); assert.equal(subscribed[3], OBJECT);
    assert.deepEqual(subscribed[5], f.state);
    assert.deepEqual(f.registrations.get('friends').diff(f.state, f.state, { objectId: OBJECT }), []);
});

test('callbacks use the requested object, safe removals, correct extensions and fresh roles/notes', () => {
    const previous = { ...empty(A), friends: [profile(B, 'real_id'), profile(C)], receivedInvitations: [invitation()] };
    const next = { ...empty(A), friends: [{ ...profile(B), note: 'new note' }], sentInvitations: [invitation(A, C, 'battle_tag')] };
    const frames = friendsWire.friendsDiff(previous, next, { objectId: OBJECT });
    assert.ok(frames.every(frame => frame.objectId === OBJECT));
    const decoded = frames.map(frame => decodeCallback(frame, 'friends_service', 'FriendsListener'));
    assert.deepEqual(decoded.map(value => value.method), ['OnFriendRemoved', 'OnUpdateFriendState', 'OnReceivedInvitationRemoved', 'OnSentInvitationAdded']);
    assert.equal(decoded[0].data.target.accountId.low.toString(), C);
    assert.equal(decoded[0].data.target.attribute.length, 0);
    assert.equal(decoded[1].data.changedFriend.attribute[0].value.stringValue, 'new note');
    assert.deepEqual(decoded[1].data.changedFriend.role, [1]);
    assert.equal(decoded[2].data.invitation.id.toString(), INVITE);
    assert.equal(Object.hasOwn(decoded[2].data.invitation, 'inviterName'), false);
    assert.equal(JSON.stringify(decoded).includes('Private'), false);
    const initial = friendsWire.friendsDiff(null, previous, { objectId: OBJECT });
    assert.equal(initial.length, 3);
});

test('email/BattleTag lookups select semantic roles, require one full selector and preserve exact parent IDs', async () => {
    const f = setup();
    assert.equal((await rpc(f.friends, 'SendInvitation', sendParameters({ targetEmail: 'friend@example.test', role: [2] }, 'hello'))).status, 0);
    assert.equal(f.calls.find(call => call[0] === 'invite')[1].kind, 'real_id');
    assert.equal(f.calls.find(call => call[0] === 'invite')[1].targetId, B);
    assert.equal(f.queries[0].limit, 2);
    f.calls.length = 0;
    assert.equal((await rpc(f.friends, 'SendInvitation', sendParameters({ targetBattleTag: 'fRiEnD#1234', role: [1] }))).status, 0);
    const query = f.queries.find(query => query.sql);
    assert.match(query.sql, /battle_tag_case_key = CAST\(LOWER\(CONVERT\(:battleTag USING utf8mb4\)\) AS BINARY\)/);
    assert.equal(query.replacements.battleTag, 'fRiEnD#1234');
    assert.equal(f.calls.find(call => call[0] === 'invite')[1].kind, 'battle_tag');
    for (const fields of [{ targetBattleTag: 'Friend' }, { targetEmail: 'friend@example.test', targetBattleTag: 'Friend#1234' },
        { targetEmail: 'friend@example.test', role: [1] }, { targetBattleTag: 'Friend#1234', role: [2] },
        { targetBattleTag: 'Friend#1234', role: [3] }, { targetBattleTag: 'Friend#1234', role: [1, 2] }]) {
        assert.notEqual((await rpc(f.friends, 'SendInvitation', sendParameters(fields))).status, 0);
    }
    f.rows.accounts = [{ id: A }, { id: B }];
    assert.equal((await rpc(f.friends, 'SendInvitation', sendParameters({ targetBattleTag: 'Friend#1234' }))).status, 0x14);
});

test('direct invitations require canonical account entities and cannot conflict with named selectors', async () => {
    const f = setup();
    assert.equal((await rpc(f.friends, 'SendInvitation', { targetId: wire.account(B), params: {} })).status, 0);
    assert.equal(f.calls.find(call => call[0] === 'invite')[1].kind, 'real_id');
    assert.equal((await rpc(f.friends, 'SendInvitation', { ...sendParameters({ targetBattleTag: 'Friend#1234' }), targetId: wire.account(B) })).status, 7);
    assert.notEqual((await rpc(f.friends, 'SendInvitation', { targetId: { high: '5', low: B }, params: {} })).status, 0);
});

test('authentication, claimed parent identities and selected game identities are enforced before mutations', async () => {
    const f = setup();
    assert.equal((await rpc(f.friends, 'RemoveFriend', { targetId: wire.account(B) }, { identity: {} })).status, 0xA);
    assert.equal((await rpc(f.friends, 'RemoveFriend', { agentId: wire.account(C), targetId: wire.account(B) })).status, 0xA);
    for (const gameId of ['9', '10']) {
        const request = { targetId: wire.account(B), params: {}, agentIdentity: { accountId: wire.account(A), gameAccountId: f.games.get(gameId).entityId } };
        assert.equal((await rpc(f.friends, 'SendInvitation', request)).status, 0xA);
    }
    assert.equal(f.calls.filter(call => ['invite', 'remove'].includes(call[0])).length, 0);
    assert.equal((await rpc(f.friends, 'SendInvitation', { targetId: wire.account(B), params: {},
        agentIdentity: { accountId: wire.account(A), gameAccountId: f.games.get('7').entityId } })).status, 0);
});

test('invitation reply ownership is delegated to the graph and retries recover deleted rows from actor receipts', async () => {
    const f = setup();
    f.rows.invitation = { id: INVITE, senderId: B, recipientId: A, kind: 'battle_tag' };
    assert.equal((await rpc(f.friends, 'AcceptInvitation', { invitationId: INVITE, options: { role: 2 } })).status, 0x1393);
    assert.equal((await rpc(f.friends, 'AcceptInvitation', { invitationId: INVITE, options: { role: 1 } })).status, 0);
    const input = f.calls.find(call => call[0] === 'accept')[1];
    assert.equal(input.targetId, B); assert.equal(input.invitationId, INVITE);
    f.rows.invitation = null;
    f.rows.receipt = { result: JSON.stringify({ invitationId: INVITE, kind: 'battle_tag', revisions: { [A]: '2', [B]: '2' } }) };
    assert.equal((await rpc(f.friends, 'AcceptInvitation', { invitationId: INVITE, options: { role: 1 } })).status, 0);
    assert.deepEqual(f.calls.filter(call => call[0] === 'accept').map(call => call[1]), [input, input]);
    assert.equal(f.queries.at(-1).where.accountId, A);
    f.rows.receipt = { result: { invitationId: '8', revisions: { [A]: '2', [B]: '2' } } };
    assert.equal((await rpc(f.friends, 'AcceptInvitation', { invitationId: INVITE })).status, 0x138E);
});

test('note mutation accepts only friend_note string attributes and retains semantic errors', async () => {
    const f = setup();
    const request = { targetId: wire.account(B), attribute: [wire.textAttribute('friend_note', 'hello')] };
    assert.equal((await rpc(f.friends, 'UpdateFriendState', request)).status, 0);
    assert.equal(f.calls.find(call => call[0] === 'setNote')[1].note, 'hello');
    for (const attribute of [[], [wire.textAttribute('other', 'hello')], [request.attribute[0], request.attribute[0]],
        [{ name: 'friend_note', value: { stringValue: 'hello', intValue: '1' } }]]) {
        assert.equal((await rpc(f.friends, 'UpdateFriendState', { ...request, attribute })).status, 7);
    }
    f.graph.setNote = async () => { throw new SocialError('INVALID_NOTE'); };
    assert.equal((await rpc(f.friends, 'UpdateFriendState', request)).status, 0x1395);
});

test('CreateFriendship cannot bypass consent; GetFriendList and ViewFriends never reuse another viewer profile', async () => {
    const f = setup();
    f.state.friends = [profile(B, 'real_id'), profile(C)];
    assert.equal((await rpc(f.friends, 'CreateFriendship', { targetId: wire.account(B), role: [1] })).status, 0xBC1);
    assert.equal((await rpc(f.friends, 'CreateFriendship', { targetId: wire.account(B), role: [99] })).status, 0x1393);
    const own = await rpc(f.friends, 'GetFriendList');
    assert.equal(own.response.friends.length, 2);
    assert.equal(JSON.stringify(own.response).includes('Private'), false);
    const viewed = await rpc(f.friends, 'ViewFriends', { targetId: wire.account(B) });
    assert.deepEqual(viewed.response.friends, []);
    const self = await rpc(f.friends, 'ViewFriends', { targetId: wire.account(A) });
    assert.equal(self.response.friends[0].fullName, 'Private Name');
    assert.equal(Object.hasOwn(self.response.friends[1], 'fullName'), false);
    assert.ok(f.calls.filter(call => call[0] === 'snapshot').every(call => call[1] === A));
});

test('committed mutation succeeds despite a reconciliation outage and session blocks bypass the persistent graph', async () => {
    const f = setup();
    f.runtime.reconcile = () => { throw new Error('Dispatcher down'); };
    assert.equal((await rpc(f.friends, 'RemoveFriend', { targetId: wire.account(B) })).status, 0);
    assert.equal((await rpc(f.blocks, 'BlockPlayerForSession', { targetId: wire.account(B) })).status, 0);
    assert.equal(f.calls.filter(call => call[0] === 'block').length, 0);
    assert.deepEqual(f.calls.find(call => call[0] === 'blockForSession').slice(1), ['session', B]);
    assert.equal((await rpc(f.blocks, 'BlockPlayer', { targetId: wire.account(B) })).status, 0);
    assert.equal(f.calls.find(call => call[0] === 'block')[1].actorId, A);
    assert.equal((await rpc(f.blocks, 'BlockPlayer', { targetId: wire.account(B), role: 99 })).status, 0x1393);
    f.graph.block = async () => { throw new SocialError('BLOCK_LIMIT'); };
    assert.equal((await rpc(f.blocks, 'BlockPlayer', { targetId: wire.account(B) })).status, 0x1F45);
});

test('block subscriptions and diffs preserve object IDs and never include profile names', async () => {
    const f = setup();
    f.state.blocks = [{ accountId: B, battleTag: 'Blocked#1234' }];
    const response = await rpc(f.blocks, 'Subscribe', { objectId: OBJECT });
    assert.equal(response.status, 0);
    assert.equal(response.response.blockedPlayers[0].name, 'Blocked#1234');
    const frames = f.registrations.get('blocks').diff(f.state, empty(A), { objectId: OBJECT });
    assert.equal(frames[0].objectId, OBJECT);
    const decoded = decodeCallback(frames[0], 'user_manager_service', 'UserManagerListener');
    assert.equal(decoded.method, 'OnBlockedPlayerRemoved');
    assert.equal(decoded.data.player.accountId.low.toString(), B);
    assert.equal(Object.hasOwn(decoded.data.player, 'name'), false);
    await rpc(f.blocks, 'Unsubscribe', { objectId: OBJECT });
    assert.deepEqual(f.calls.find(call => call[0] === 'unsubscribe').slice(1), ['blocks', A, OBJECT]);
});

test('block subscriptions merge durable and session blocks, and unblocking does not clear another session', async () => {
    const f = setup();
    f.state.blocks = [{ accountId: B, battleTag: 'Durable#1234' }];
    await f.session().blockForSession(B);
    await f.session().blockForSession(C);
    const other = f.session({ ...f.owner, sessionKey: 'other-license' });
    await other.blockForSession(C);
    const subscribed = await rpc(f.blocks, 'Subscribe', { objectId: OBJECT });
    assert.deepEqual(subscribed.response.blockedPlayers.map(value => value.accountId.low.toString()), [B, C]);
    assert.equal((await rpc(f.blocks, 'UnblockPlayer', { targetId: wire.account(C) })).status, 0);
    assert.deepEqual((await f.session().sessionBlocks()).map(value => value.accountId), [B]);
    assert.deepEqual((await other.sessionBlocks()).map(value => value.accountId), [C]);
});

test('typed reports resolve the full parent, bind reporter ownership, and preserve server-controlled report reasons', async () => {
    const f = setup();
    const handle = { id: 9, program: 0x576F57, region: 1 };
    const request = { agentId: { ...handle, id: 7 }, reportType: { note: 'context', harassmentReport: { target: handle, text: 'offending text' } } };
    assert.equal((await rpc(f.reports, 'SubmitReport', request)).status, 0);
    const report = f.calls.find(call => call[0] === 'report')[1];
    assert.equal(report.actorId, A); assert.equal(report.targetId, B);
    assert.equal(report.reason, 'harassment');
    assert.deepEqual(JSON.parse(report.details), { note: 'context', gameAccountId: '9', text: 'offending text' });
    assert.equal((await rpc(f.reports, 'SubmitReport', { ...request, agentId: handle })).status, 0xA);
    assert.equal((await rpc(f.reports, 'SubmitReport', { ...request, agentId: { ...handle, id: 10 } })).status, 0xA);
    assert.equal((await rpc(f.reports, 'SubmitReport', { reportType: { hackingReport: { target: { ...handle, region: 2 } } } })).status, 0x11);
});

test('report sizes, mixed types and unknown custom contracts fail without storing a report', async () => {
    const f = setup();
    const target = { id: 9, program: 0x576F57, region: 1 };
    for (const [reportType, status] of [
        [{ note: 'é'.repeat(2049), spamReport: { target } }, 0xAFC9],
        [{ customReport: { type: 'invented' } }, 0xAFCA],
        [{ hackingReport: {} }, 0xAFCB]
    ]) { assert.equal((await rpc(f.reports, 'SubmitReport', { reportType })).status, status); }
    // Proto2 deliberately discards unknown enum numbers during decoding. Validate an explicitly
    // supplied invalid enum in a direct handler context too, without relying on fromObject's coercion.
    await assert.rejects(f.reports.SubmitReport({ identity: { sessionKey: 'session' }, request: {
        reportType: { spamReport: { target, source: 99 } }
    } }), value => value === 0xAFCB);
    // Protobuf oneof decoding uses the last field, so ambiguity is testable only before that boundary.
    await assert.rejects(f.reports.SubmitReport({ identity: { sessionKey: 'session' }, request: {
        reportType: { spamReport: { target }, bottingReport: { target } }
    } }), value => value === 0xAFCA);
    assert.equal((await rpc(f.reports, 'SendReport', { report: { reportType: 'spam', reportingAccount: wire.account(B) } })).status, 0xA);
    assert.equal((await rpc(f.reports, 'SendReport', { report: { reportType: 'spam', reportingAccount: wire.account(A) } })).status, 0xBC7);
    assert.equal(f.calls.filter(call => call[0] === 'report').length, 0);
});

test('typed report handles reject wide identities instead of truncating them into another license', async () => {
    const f = setup();
    await assert.rejects(friendsWire.gameHandle(f.models, { id: Number(A), program: 0x576F57, region: 1 }), error => error === 0x11);
    f.owner.gameAccountId = A;
    await assert.rejects(friendsWire.gameHandle(f.models, { id: 7, program: 0x576F57, region: 1 }, f.owner), error => error === 0xA);
    assert.throws(() => friendsWire.storedId(Number(A)), /Imprecise stored social identity/);
    assert.equal(friendsWire.storedId(7), '7');
});

test('encoded adapters integrate with graph receipts, Real ID consent, notes and bidirectional blocks', async t => {
    const f = fixture();
    t.after(() => f.sequelize.close());
    for (const id of [A, B, C]) { await f.account(id, { realIdEnabled: true }); }
    const registry = new Map();
    const runtime = {
        graph: f.graph,
        session: async context => fakeSession({ accountId: context.identity.sessionKey, sessionKey: context.identity.sessionKey }, { context,
            methods: { operationId: () => createHash('sha256').update(JSON.stringify([
                context.identity.sessionKey, context.header.methodId, context.operation
            ])).digest('hex') } }),
        register: (kind, hooks) => registry.set(kind, hooks), reconcile: async () => {}
    };
    const models = { ...f.models, Account: f.Account, sequelize: f.sequelize };
    const deps = { runtime, models, logger: { error() {}, debug() {} } };
    const service = new FriendsService(deps); const blocks = new UserManagerService(deps);
    const call = (name, request, actor, operation, target = service) => rpc(target, name, request, {
        identity: { sessionKey: actor }, operation
    });
    const invite = kind => ({ targetId: wire.account(B), params: { [friendsWire.PARAMS]: { role: [kind] } } });
    assert.equal((await call('SendInvitation', invite(1), A, 'invite-btag')).status, 0);
    const subscribed = await call('Subscribe', { objectId: OBJECT }, B, 'subscribe');
    const invitationId = subscribed.response.receivedInvitations[0].id.toString();
    assert.equal(invitationId, '9007199254740993');
    assert.equal((await call('AcceptInvitation', { invitationId, options: { role: 2 } }, B, 'accept')).status, 0x1393);
    const accept = { invitationId, options: { role: 1 } };
    assert.equal((await call('AcceptInvitation', accept, B, 'accept')).status, 0);
    const revision = (await f.graph.snapshot(B)).revision;
    // Same request after the invitation row was deleted reaches the graph's original successful receipt.
    assert.equal((await call('AcceptInvitation', accept, B, 'accept')).status, 0);
    assert.equal((await f.graph.snapshot(B)).revision, revision);
    assert.equal((await f.graph.project(A, B)).fullName, '');
    const beforeNote = await registry.get('friends').snapshot({ accountId: A });
    assert.equal((await call('UpdateFriendState', { targetId: wire.account(B),
        attribute: [wire.textAttribute('friend_note', 'my private note')] }, A, 'note')).status, 0);
    assert.equal((await f.graph.project(B, A)).note, '');
    const changed = registry.get('friends').diff(beforeNote, await f.graph.snapshot(A), { objectId: OBJECT });
    assert.equal(decodeCallback(changed[0], 'friends_service', 'FriendsListener').method, 'OnUpdateFriendState');
    assert.equal((await call('SendInvitation', invite(2), A, 'upgrade-rid')).status, 0);
    const upgrade = (await f.graph.snapshot(B)).receivedInvitations[0].invitationId;
    assert.equal((await call('AcceptInvitation', { invitationId: upgrade, options: { role: 2 } }, B, 'accept-rid')).status, 0);
    assert.equal((await f.graph.project(A, B)).fullName, 'Private Person');
    await f.Account.update({ realIdEnabled: false }, { where: { id: B } });
    assert.equal((await f.graph.project(A, B)).fullName, '');
    assert.equal((await call('BlockPlayer', { targetId: wire.account(A) }, B, 'block', blocks)).status, 0);
    assert.equal((await f.graph.snapshot(A)).friends.length, 0);
    assert.equal((await f.graph.access(A, B)).canWhisper, false);
    assert.equal((await call('SendInvitation', invite(1), A, 'new-invite')).status, 0x1391);
    assert.equal((await call('BlockPlayerForSession', { targetId: wire.account(C) }, B, 'temporary', blocks)).status, 0);
    assert.deepEqual((await f.graph.snapshot(B)).blocks.map(value => value.accountId), [A]);
    // Replaying an older committed request does not undo a later block or recreate its invitation.
    assert.equal((await call('SendInvitation', invite(1), A, 'invite-btag')).status, 0);
    assert.equal((await f.graph.snapshot(A)).sentInvitations.length, 0);
    assert.equal(JSON.stringify(await f.graph.pendingOutbox()).includes('my private note'), false);
});

test('committed mutation replies before slow notification reconciliation and retains an after-reply hook', async () => {
    const f = setup();
    let release;
    const stalled = new Promise(resolve => { release = resolve; });
    let reconciliations = 0;
    f.runtime.reconcile = () => { reconciliations++; return stalled; };
    let timer;
    try {
        const result = await Promise.race([
            rpc(f.friends, 'RemoveFriend', { targetId: wire.account(B) }),
            new Promise((resolve, reject) => { timer = setTimeout(() => reject(new Error('Reply waited for notification delivery')), 100); })
        ]);
        assert.equal(result.status, 0);
        assert.equal(reconciliations, 0);
        assert.equal(typeof result.context.afterReply, 'function');
        const delivery = result.context.afterReply();
        await new Promise(resolve => setImmediate(resolve));
        assert.equal(reconciliations, 2);
        release();
        await delivery;
    }
    finally { clearTimeout(timer); release(); }
});
