'use strict';

const wire = require('./wire');

const PARAMS = '.bgs.protocol.friends.v1.FriendInvitationParams.friendParams';
const INVITATION = '.bgs.protocol.friends.v1.FriendInvitation.friendInvitation';
// The recovered client resolves these IDs by the advertised role NAME.
const ROLES = Object.freeze([
    Object.freeze({ id: 1, name: 'battle_tag_friend' }),
    Object.freeze({ id: 2, name: 'real_id_friend' })
]);

function role(kind) {
    if (kind === 'battle_tag') { return 1; }
    if (kind === 'real_id') { return 2; }
    throw new Error('Unknown semantic friendship kind');
}
function kind(value) {
    if (value === 1) { return 'battle_tag'; }
    if (value === 2) { return 'real_id'; }
    throw 0x1393; // ERROR_FRIENDS_INVALID_ROLE_ID
}
function storedId(value) {
    if (typeof value === 'number' && !Number.isSafeInteger(value)) { throw new Error('Imprecise stored social identity'); }
    return wire.id(String(value));
}
function friend(value, removed = false) {
    const result = { accountId: wire.account(value.accountId) };
    if (!removed) {
        result.role = [role(value.kind)];
        result.attribute = [wire.textAttribute('friend_note', value.note || '')];
    }
    return result;
}
function received(value, removed = false) {
    const result = { id: value.invitationId, inviterIdentity: { accountId: wire.account(value.senderId) },
        inviteeIdentity: { accountId: wire.account(value.recipientId) } };
    if (!removed) {
        result.inviterName = value.peer.battleTag;
        result.invitationMessage = value.message;
        result[INVITATION] = { role: [role(value.kind)] };
    }
    return result;
}
function sent(value) {
    return { id: value.invitationId, targetName: value.peer.battleTag, role: role(value.kind) };
}
function blocked(value, removed = false) {
    return { accountId: wire.account(value.accountId), ...(!removed ? { name: value.battleTag } : {}) };
}
function subscribe(snapshot, limits) {
    return {
        maxFriends: limits.friends, maxReceivedInvitations: limits.invitations, maxSentInvitations: limits.invitations,
        role: ROLES.map(value => ({ ...value })), friends: snapshot.friends.map(value => friend(value)),
        receivedInvitations: snapshot.receivedInvitations.map(value => received(value)),
        sentInvitations: snapshot.sentInvitations.map(sent)
    };
}

function friendsDiff(previous, next, row) {
    const frames = [];
    const accountId = wire.account(next.accountId);
    const emit = (method, data) => frames.push(wire.notification('friends_service', 'FriendsListener', method,
        String(row.objectId), { accountId, ...data }));
    const prior = previous || { friends: [], receivedInvitations: [], sentInvitations: [] };
    const oldFriends = new Map(prior.friends.map(value => [value.accountId, value]));
    const newFriends = new Map(next.friends.map(value => [value.accountId, value]));
    for (const [id, value] of oldFriends) {
        if (!newFriends.has(id)) { emit('OnFriendRemoved', { target: friend(value, true) }); }
    }
    for (const [id, value] of newFriends) {
        const before = oldFriends.get(id);
        if (!before) { emit('OnFriendAdded', { target: friend(value) }); }
        else if (before.kind !== value.kind || before.note !== value.note) {
            emit('OnUpdateFriendState', { changedFriend: friend(value) });
        }
    }
    for (const direction of ['receivedInvitations', 'sentInvitations']) {
        const oldRows = new Map(prior[direction].map(value => [value.invitationId, value]));
        const newRows = new Map(next[direction].map(value => [value.invitationId, value]));
        for (const [id, value] of oldRows) {
            if (!newRows.has(id)) {
                if (direction === 'receivedInvitations') { emit('OnReceivedInvitationRemoved', { invitation: received(value, true) }); }
                else { emit('OnSentInvitationRemoved', { invitationId: id }); }
            }
        }
        for (const [id, value] of newRows) {
            if (!oldRows.has(id)) {
                if (direction === 'receivedInvitations') { emit('OnReceivedInvitationAdded', { invitation: received(value) }); }
                else { emit('OnSentInvitationAdded', { invitation: sent(value) }); }
            }
        }
    }
    return frames;
}

function blocksDiff(previous, next, row) {
    const frames = [];
    const before = new Map((previous?.blocks || []).map(value => [value.accountId, value]));
    const after = new Map(next.blocks.map(value => [value.accountId, value]));
    const emit = (method, player) => frames.push(wire.notification('user_manager_service', 'UserManagerListener', method,
        String(row.objectId), { player, accountId: wire.account(next.accountId) }));
    for (const [id, value] of before) {
        if (!after.has(id)) { emit('OnBlockedPlayerRemoved', blocked(value, true)); }
    }
    for (const [id, value] of after) {
        if (!before.has(id)) { emit('OnBlockedPlayerAdded', blocked(value)); }
        else if (before.get(id).battleTag !== value.battleTag) {
            emit('OnBlockedPlayerRemoved', blocked(value, true));
            emit('OnBlockedPlayerAdded', blocked(value));
        }
    }
    return frames;
}

async function gameEntity(models, entity, owner) {
    const game = await models.GameAccount.findByPk(wire.id(entity?.low));
    if (!game || entity?.high?.toString() !== game.entityId.high.toString()) { throw 0x11; }
    const accountId = storedId(game.accountId); const gameId = storedId(game.id);
    if (owner && (accountId !== owner.accountId || (owner.gameAccountId && gameId !== owner.gameAccountId))) { throw 0xA; }
    return game;
}

async function gameHandle(models, handle, owner) {
    if (!handle || !Number.isInteger(handle.id) || handle.id <= 0 || handle.id > 0xffffffff ||
        !Number.isInteger(handle.program) || handle.program < 0 || handle.program > 0xffffffff ||
        !Number.isInteger(handle.region) || handle.region < 0 || handle.region > 0xff) { throw 0x11; }
    // The typed report contract has only a 32-bit handle. Never alias a wider game account by truncation.
    const game = await models.GameAccount.findByPk(String(handle.id));
    if (!game || game.entityId.high.getLowBitsUnsigned() !== handle.program || game.region !== handle.region) { throw 0x11; }
    const accountId = storedId(game.accountId); const gameId = storedId(game.id);
    if (owner && (accountId !== owner.accountId || (owner.gameAccountId && gameId !== owner.gameAccountId))) { throw 0xA; }
    return game;
}

async function ownerFor(runtime, models, context) {
    const owner = await runtime.owner(context);
    wire.id(owner.accountId);
    wire.actor(context.request || {}, owner);
    if (context.request?.agentIdentity?.gameAccountId) {
        await gameEntity(models, context.request.agentIdentity.gameAccountId, owner);
    }
    return owner;
}

// Values are taken from legion-core/src/server/proto/BattlenetRpcErrorCodes.h.
// Ambiguous cap errors use ERROR_SERVER_BUSY instead of guessing inviter/invitee-specific statuses.
function status(error, service = 'friends') {
    if (Number.isInteger(error)) { return error; }
    const common = {
        ACCOUNT_NOT_FOUND: 0x14, SELF_TARGET: service === 'blocks' ? 0x1F42 : 0x7,
        BLOCKED: 0x1391, NOT_FRIENDS: 0x138C, REAL_ID_DISABLED: 0x1394,
        INVITATION_NOT_FOUND: 0x138E, INVITATION_CONFLICT: 0x138E,
        INVITATION_NOT_RECIPIENT: 0xBC1, INVITATION_NOT_OWNER: 0xBC1,
        INVALID_NOTE: 0x1395, BLOCK_LIMIT: 0x1F45, REPORT_LIMIT: 0xAFD0, INVALID_REPORT: 0xAFCB,
        FRIEND_LIMIT: 0x25, INVITATION_LIMIT: 0x25, OUTBOX_FULL: 0x25,
        INVALID_KIND: 0x1393, OPERATION_CONFLICT: 0x7,
        INVALID_ID: 0x7, INVALID_MESSAGE: 0x7, INVALID_OPERATION_ID: 0x7, INVALID_LIMIT: 0x7
    };
    return common[error?.code] || 0x1;
}

function reconcile(runtime, result, context) {
    deferReconcile(runtime, Object.keys(result.revisions), context);
}
function deferReconcile(runtime, accountIds, context) {
    // The mutation and outbox have already committed. Reply before notification work: even a slow
    // dispatcher must not make a successful mutation look uncertain to the client. Both receivers
    // run afterReply only after publishing the response. The durable outbox also recovers a lost hook.
    const after = context.afterReply;
    context.afterReply = async () => {
        await after?.();
        await Promise.allSettled(accountIds.map(accountId => Promise.resolve().then(() => runtime.reconcile(accountId))));
    };
}

module.exports = { PARAMS, INVITATION, ROLES, role, kind, storedId, friend, received, sent, blocked, subscribe,
    friendsDiff, blocksDiff, gameEntity, gameHandle, ownerFor, status, reconcile, deferReconcile };
