'use strict';

const { jsonColumn: json } = require('../utils/json-column');
const { createHash } = require('node:crypto');
const { Op, Transaction, DataTypes } = require('sequelize');
const defineModels = require('../models/socialgraph');
const { SocialError } = require('./errors');

const MAX_ACCOUNT = 9223372036854775807n; // accounts.id is signed BIGINT.
const MAX_COUNTER = 18446744073709551615n;
const PROFILE = ['id', 'battleTag', 'givenName', 'surname', 'realIdEnabled'];
const LIMITS = Object.freeze({ friends: 200, invitations: 100, blocks: 100, reportsPerDay: 20, pendingEvents: 1024 });
const CEILINGS = { friends: 1000, invitations: 500, blocks: 100, reportsPerDay: 100, pendingEvents: 4096 };

function fail(code) { throw new SocialError(code); }
function id(value, maximum = MAX_ACCOUNT) {
    if (typeof value !== 'string' || !/^[1-9][0-9]{0,19}$/.test(value) || BigInt(value) > maximum) {
        fail('INVALID_ID');
    }
    return value;
}
function stored(value, maximum = MAX_ACCOUNT) {
    if (typeof value === 'number' && !Number.isSafeInteger(value)) { fail('INVALID_STORED_ID'); }
    return id(String(value), maximum);
}
function revision(value) {
    if (value === undefined || value === '0' || value === 0) { return '0'; }
    return stored(value, MAX_COUNTER);
}
function ordered(a, b) { return BigInt(a) < BigInt(b) ? [a, b] : [b, a]; }
function pair(a, b) { const [lowId, highId] = ordered(a, b); return { lowId, highId }; }
function either(a, b, first, second) {
    return { [Op.or]: [{ [first]: a, [second]: b }, { [first]: b, [second]: a }] };
}
function text(value, bytes, code, empty = true) {
    if (typeof value !== 'string' || !value.isWellFormed() || value.includes('\0') ||
        Buffer.byteLength(value, 'utf8') > bytes || (!empty && !value.trim())) { fail(code); }
    return value;
}
function friendshipKind(value) {
    if (value !== 'real_id' && value !== 'battle_tag') { fail('INVALID_KIND'); }
    return value;
}
function optedIn(profile) { return profile.realIdEnabled === true || profile.realIdEnabled === 1; }
function realNames(viewer, subject, kind) { return kind === 'real_id' && optedIn(viewer) && optedIn(subject); }
// The only place a real name leaves the graph (ADR-0001): fullName is empty
// unless both sides of a Real ID friendship, or an opted-in self-view, allow it.
function profile(viewer, subject, kind = null, visible = realNames(viewer, subject, kind)) {
    return {
        accountId: stored(subject.id), battleTag: subject.battleTag, kind,
        fullName: visible ? [subject.givenName, subject.surname].filter(Boolean).join(' ') : '',
        realIdVisible: visible
    };
}

// Both callers must already hold the parent Account UPDATE lock. Session rows from every
// license count, including expired owners until cleanup; duplicates consume one native slot.
async function assertBlockCapacity(models, accountId, targetId, transaction, limit = LIMITS.blocks) {
    const targets = new Set();
    for (const [model, field] of [[models.SocialBlock, 'blockedId'], [models.SocialSessionBlock, 'blockedAccountId']]) {
        const rows = await model.findAll({ where: { accountId }, attributes: [field], group: [field],
            order: [[field, 'ASC']], limit: limit + 1, transaction, raw: true });
        for (const row of rows) { targets.add(stored(row[field])); }
    }
    if (targets.size > limit || (!targets.has(targetId) && targets.size >= limit)) { fail('BLOCK_LIMIT'); }
}

/**
 * Parent-account policy, independent of protocol role/status numbers.
 * The adapter MUST supply actorId from its authenticated principal, never a request's agent/reporter field.
 * All input account IDs are canonical decimal strings; invitation/report IDs are unsigned decimal strings.
 * operationId is a caller-generated stable retry key, scoped to actorId, not a transient RPC token.
 * Successful receipts are permanent. Reuse with different arguments fails, including after graph changes.
 * Models can be supplied from the database registry, or are defined on the supplied Sequelize instance.
 */
class SocialGraph {
    constructor({ sequelize, Account, models, limits = {}, now = () => new Date() }) {
        this.sequelize = sequelize;
        this.Account = Account;
        this.models = models || { ...defineModels(sequelize, DataTypes),
            SocialSessionBlock: sequelize.models.SocialSessionBlock || require('../models/socialsessionblock')(sequelize, DataTypes) };
        this.now = now;
        this.limits = { ...LIMITS, ...limits };
        for (const [key, value] of Object.entries(this.limits)) {
            if (!Object.hasOwn(CEILINGS, key) || !Number.isSafeInteger(value) || value < 1 || value > CEILINGS[key]) {
                fail('INVALID_LIMIT');
            }
        }
    }

    async _accounts(ids, transaction, lock = false) {
        const result = new Map();
        // Lock individually: ORDER BY does not guarantee the optimizer's row-lock acquisition order.
        for (const accountId of [...new Set(ids)].sort((a, b) => BigInt(a) < BigInt(b) ? -1 : 1)) {
            const account = await this.Account.findByPk(accountId, {
                attributes: PROFILE, transaction, ...(lock ? { lock: transaction.LOCK.UPDATE } : {}), raw: true
            });
            if (!account) { fail('ACCOUNT_NOT_FOUND'); }
            result.set(accountId, account);
        }
        return result;
    }

    async _mutate(action, input, work) {
        const { actorId, targetId, operationId } = input;
        id(actorId); id(targetId);
        if (actorId === targetId) { fail('SELF_TARGET'); }
        if (typeof operationId !== 'string' || !/^[A-Za-z0-9_.:-]{1,64}$/.test(operationId)) { fail('INVALID_OPERATION_ID'); }
        const requestHash = createHash('sha256').update(JSON.stringify({ action, ...input })).digest('hex');
        const M = this.models;
        return this.sequelize.transaction({ isolationLevel: Transaction.ISOLATION_LEVELS.READ_COMMITTED }, async transaction => {
            const accounts = await this._accounts([actorId, targetId], transaction, true);
            const receipt = await M.SocialMutation.findOne({ where: { accountId: actorId, operationId }, transaction, raw: true });
            if (receipt) {
                if (receipt.requestHash !== requestHash) { fail('OPERATION_CONFLICT'); }
                return json(receipt.result);
            }
            const changed = new Map();
            const change = (accountId, type) => {
                if (!changed.has(accountId)) { changed.set(accountId, new Set()); }
                changed.get(accountId).add(type);
            };
            const at = this.now();
            const result = await work({ transaction, accounts, change, at });
            const revisions = {};
            for (const accountId of ordered(actorId, targetId)) {
                const row = await M.SocialRevision.findOne({ where: { accountId }, transaction });
                let current = revision(row?.revision);
                if (changed.has(accountId)) {
                    const pending = await M.SocialOutbox.count({ where: { accountId, publishedAt: null }, transaction });
                    if (pending >= this.limits.pendingEvents) { fail('OUTBOX_FULL'); }
                    if (BigInt(current) === MAX_COUNTER) { fail('REVISION_EXHAUSTED'); }
                    current = String(BigInt(current) + 1n);
                    if (row) { await row.update({ revision: current }, { transaction }); }
                    else { await M.SocialRevision.create({ accountId, revision: current }, { transaction }); }
                    // A consumer must reread authorized state. Do not persist cached private profile data in events.
                    await M.SocialOutbox.create({ accountId, revision: current, createdAt: at, publishedAt: null, payload: {
                        type: 'graph.changed', accountId, revision: current,
                        peerId: accountId === actorId ? targetId : actorId, changes: [...changed.get(accountId)].sort()
                    } }, { transaction });
                }
                revisions[accountId] = current;
            }
            const response = { changed: changed.size > 0, revisions, ...result };
            await M.SocialMutation.create({ accountId: actorId, operationId, requestHash, result: response, createdAt: at }, { transaction });
            return response;
        });
    }

    async _blocked(actorId, targetId, transaction) {
        return Boolean(await this.models.SocialBlock.findOne({
            where: either(actorId, targetId, 'accountId', 'blockedId'), transaction, raw: true
        }));
    }

    async _unblocked(actorId, targetId, transaction) {
        if (await this._blocked(actorId, targetId, transaction)) { fail('BLOCKED'); }
    }

    async _friend(actorId, targetId, transaction) {
        return this.models.SocialFriendship.findOne({ where: pair(actorId, targetId), transaction, raw: true });
    }

    async _requireFriend(actorId, targetId, transaction) {
        await this._unblocked(actorId, targetId, transaction);
        const friend = await this._friend(actorId, targetId, transaction);
        if (!friend) { fail('NOT_FRIENDS'); }
        return friend;
    }

    _requireRealId(accounts, kind) {
        if (kind === 'real_id' && [...accounts.values()].some(account => !optedIn(account))) { fail('REAL_ID_DISABLED'); }
    }

    async _capacity(model, where, maximum, transaction, code) {
        if (await model.count({ where, transaction }) >= maximum) { fail(code); }
    }

    async _friendCapacity(accountId, transaction) {
        await this._capacity(this.models.SocialFriendship, { [Op.or]: [{ lowId: accountId }, { highId: accountId }] },
            this.limits.friends, transaction, 'FRIEND_LIMIT');
    }

    async invite({ actorId, targetId, kind, operationId, message = '' }) {
        friendshipKind(kind); text(message, 1024, 'INVALID_MESSAGE');
        return this._mutate('invite', { actorId, targetId, kind, operationId, message }, async ({ transaction, accounts, change, at }) => {
            await this._unblocked(actorId, targetId, transaction);
            const friend = await this._friend(actorId, targetId, transaction);
            if (friend && (friend.kind === kind || friend.kind === 'real_id')) { return { kind: friend.kind }; }
            this._requireRealId(accounts, kind);
            const existing = await this.models.SocialInvitation.findOne({ where: pair(actorId, targetId), transaction, raw: true });
            if (existing) {
                if (existing.kind !== kind) { fail('INVITATION_CONFLICT'); }
                // A reciprocal invitation is not implicit consent to accept the other account's request.
                return { invitationId: stored(existing.id, MAX_COUNTER), senderId: stored(existing.senderId), kind };
            }
            if (!friend) {
                await this._friendCapacity(actorId, transaction);
                await this._friendCapacity(targetId, transaction);
            }
            const M = this.models;
            await this._capacity(M.SocialInvitation, { senderId: actorId }, this.limits.invitations, transaction, 'INVITATION_LIMIT');
            await this._capacity(M.SocialInvitation, { recipientId: targetId }, this.limits.invitations, transaction, 'INVITATION_LIMIT');
            const invitation = await M.SocialInvitation.create({ ...pair(actorId, targetId), senderId: actorId, recipientId: targetId,
                kind, message, createdAt: at }, { transaction });
            change(actorId, 'invitations'); change(targetId, 'invitations');
            return { invitationId: stored(invitation.id, MAX_COUNTER), senderId: actorId, kind };
        });
    }

    async _invitation(actorId, targetId, invitationId, transaction) {
        const row = await this.models.SocialInvitation.findOne({ where: pair(actorId, targetId), transaction, raw: true });
        if (row && stored(row.id, MAX_COUNTER) !== invitationId) { fail('INVITATION_CONFLICT'); }
        return row;
    }

    async accept({ actorId, targetId, invitationId, operationId }) {
        id(invitationId, MAX_COUNTER);
        return this._mutate('accept', { actorId, targetId, invitationId, operationId }, async ({ transaction, accounts, change, at }) => {
            await this._unblocked(actorId, targetId, transaction);
            const invitation = await this._invitation(actorId, targetId, invitationId, transaction);
            if (!invitation) { fail('INVITATION_NOT_FOUND'); }
            if (stored(invitation.recipientId) !== actorId) { fail('INVITATION_NOT_RECIPIENT'); }
            this._requireRealId(accounts, invitation.kind);
            const friend = await this._friend(actorId, targetId, transaction);
            const where = pair(actorId, targetId);
            if (!friend) {
                await this._friendCapacity(actorId, transaction);
                await this._friendCapacity(targetId, transaction);
                await this.models.SocialFriendship.create({ ...where, kind: invitation.kind, createdAt: at }, { transaction });
            }
            else if (friend.kind === 'battle_tag' && invitation.kind === 'real_id') {
                await this.models.SocialFriendship.update({ kind: 'real_id' }, { where, transaction });
            }
            await this.models.SocialInvitation.destroy({ where: { id: invitationId }, transaction });
            change(actorId, 'friends'); change(targetId, 'friends');
            change(actorId, 'invitations'); change(targetId, 'invitations');
            return { kind: friend?.kind === 'real_id' ? 'real_id' : invitation.kind, invitationId };
        });
    }

    async _dismiss(action, { actorId, targetId, invitationId, operationId }) {
        id(invitationId, MAX_COUNTER);
        return this._mutate(action, { actorId, targetId, invitationId, operationId }, async ({ transaction, change }) => {
            const invitation = await this._invitation(actorId, targetId, invitationId, transaction);
            if (!invitation) { return { invitationId }; }
            const permitted = action === 'revoke' ? invitation.senderId : invitation.recipientId;
            if (stored(permitted) !== actorId) { fail('INVITATION_NOT_OWNER'); }
            await this.models.SocialInvitation.destroy({ where: { id: invitationId }, transaction });
            change(actorId, 'invitations'); change(targetId, 'invitations');
            return { invitationId };
        });
    }

    revoke(input) { return this._dismiss('revoke', input); }
    decline(input) { return this._dismiss('decline', input); }

    async _removePair(actorId, targetId, transaction, change) {
        const where = pair(actorId, targetId);
        if (await this.models.SocialFriendship.destroy({ where, transaction })) {
            change(actorId, 'friends'); change(targetId, 'friends');
        }
        if (await this.models.SocialInvitation.destroy({ where, transaction })) {
            change(actorId, 'invitations'); change(targetId, 'invitations');
        }
        await this.models.SocialNote.destroy({ where: either(actorId, targetId, 'accountId', 'friendId'), transaction });
    }

    remove({ actorId, targetId, operationId }) {
        return this._mutate('remove', { actorId, targetId, operationId }, async ({ transaction, change }) => {
            await this._removePair(actorId, targetId, transaction, change);
            return {};
        });
    }

    async setNote({ actorId, targetId, operationId, note }) {
        text(note, 1024, 'INVALID_NOTE');
        return this._mutate('setNote', { actorId, targetId, operationId, note }, async ({ transaction, change }) => {
            await this._requireFriend(actorId, targetId, transaction);
            const M = this.models.SocialNote;
            const where = { accountId: actorId, friendId: targetId };
            const existing = await M.findOne({ where, transaction });
            if ((existing?.note || '') === note) { return {}; }
            if (!note) { await M.destroy({ where, transaction }); }
            else if (existing) { await existing.update({ note }, { transaction }); }
            else { await M.create({ ...where, note }, { transaction }); }
            change(actorId, 'notes');
            return {};
        });
    }

    block({ actorId, targetId, operationId }) {
        return this._mutate('block', { actorId, targetId, operationId }, async ({ transaction, change, at }) => {
            const M = this.models.SocialBlock;
            const where = { accountId: actorId, blockedId: targetId };
            if (await M.findOne({ where, transaction, raw: true })) { return {}; }
            await assertBlockCapacity(this.models, actorId, targetId, transaction, this.limits.blocks);
            await M.create({ ...where, createdAt: at }, { transaction });
            await this._removePair(actorId, targetId, transaction, change);
            change(actorId, 'blocks');
            // Invalidate both access caches without telling the peer who blocked them.
            change(actorId, 'access'); change(targetId, 'access');
            return {};
        });
    }

    unblock({ actorId, targetId, operationId }) {
        return this._mutate('unblock', { actorId, targetId, operationId }, async ({ transaction, change }) => {
            const deleted = await this.models.SocialBlock.destroy({ where: { accountId: actorId, blockedId: targetId }, transaction });
            if (deleted) {
                change(actorId, 'blocks'); change(actorId, 'access'); change(targetId, 'access');
            }
            // Unblocking does not restore a cancelled friendship or invitation.
            return {};
        });
    }

    async report({ actorId, targetId, operationId, reason, details = '' }) {
        text(reason, 64, 'INVALID_REPORT', false); text(details, 4096, 'INVALID_REPORT');
        return this._mutate('report', { actorId, targetId, operationId, reason, details }, async ({ transaction, change, at }) => {
            await this._capacity(this.models.SocialReport, { reporterId: actorId, createdAt: { [Op.gte]: new Date(at.getTime() - 86400000) } },
                this.limits.reportsPerDay, transaction, 'REPORT_LIMIT');
            const report = await this.models.SocialReport.create({ reporterId: actorId, targetId, reason, details, createdAt: at }, { transaction });
            change(actorId, 'reports');
            return { reportId: stored(report.id, MAX_COUNTER) };
        });
    }

    async _read(actorId, targetId, read) {
        id(actorId);
        if (targetId !== undefined) { id(targetId); if (actorId === targetId) { fail('SELF_TARGET'); } }
        // All fields and revision come from the same database snapshot, including profile opt-in.
        return this.sequelize.transaction({ isolationLevel: Transaction.ISOLATION_LEVELS.REPEATABLE_READ }, async transaction => {
            const accounts = await this._accounts(targetId === undefined ? [actorId] : [actorId, targetId], transaction);
            return read(transaction, accounts);
        });
    }

    async access(actorId, targetId) {
        return this._read(actorId, targetId, async (transaction, accounts) => {
            const blocked = await this._blocked(actorId, targetId, transaction);
            const friend = blocked ? null : await this._friend(actorId, targetId, transaction);
            return {
                friends: Boolean(friend), kind: friend?.kind || null, blocked, canInvite: !blocked,
                canWhisper: Boolean(friend), canSubscribePresence: Boolean(friend), canInviteToConversation: Boolean(friend),
                canSeeRealName: Boolean(friend && realNames(accounts.get(actorId), accounts.get(targetId), friend.kind))
            };
        });
    }

    async assertAccess(actorId, targetId, action) {
        const field = { whisper: 'canWhisper', presence: 'canSubscribePresence', conversation: 'canInviteToConversation' }[action];
        if (!field) { fail('INVALID_ACCESS_ACTION'); }
        const access = await this.access(actorId, targetId);
        if (!access[field]) { fail(access.blocked ? 'BLOCKED' : 'NOT_FRIENDS'); }
        return access;
    }

    // The actor's view of one account: its own profile, or a friend's. Null when not visible.
    async project(actorId, targetId) {
        if (actorId === targetId) {
            return this._read(actorId, undefined, async (transaction, accounts) => {
                const self = accounts.get(actorId);
                return { ...profile(self, self, null, optedIn(self)), note: '' };
            });
        }
        return this._read(actorId, targetId, async (transaction, accounts) => {
            if (await this._blocked(actorId, targetId, transaction)) { return null; }
            const friend = await this._friend(actorId, targetId, transaction);
            if (!friend) { return null; }
            const note = await this.models.SocialNote.findOne({ where: { accountId: actorId, friendId: targetId }, transaction, raw: true });
            return { ...profile(accounts.get(actorId), accounts.get(targetId), friend.kind), note: note?.note || '' };
        });
    }

    async _bounded(model, where, limit, order, transaction) {
        const rows = await model.findAll({ where, limit: limit + 1, order, transaction, raw: true });
        if (rows.length > limit) { fail('SNAPSHOT_LIMIT'); }
        return rows;
    }

    async snapshot(actorId) {
        return this._read(actorId, undefined, async (transaction, accounts) => {
            const M = this.models;
            const state = await M.SocialRevision.findOne({ where: { accountId: actorId }, transaction, raw: true });
            const friends = await this._bounded(M.SocialFriendship, { [Op.or]: [{ lowId: actorId }, { highId: actorId }] },
                this.limits.friends, [['lowId', 'ASC'], ['highId', 'ASC']], transaction);
            const invitations = await this._bounded(M.SocialInvitation, { [Op.or]: [{ senderId: actorId }, { recipientId: actorId }] },
                this.limits.invitations * 2, [['id', 'ASC']], transaction);
            const blocks = await this._bounded(M.SocialBlock, { accountId: actorId }, this.limits.blocks, [['blockedId', 'ASC']], transaction);
            const notes = await this._bounded(M.SocialNote, { accountId: actorId }, this.limits.friends, [['friendId', 'ASC']], transaction);
            const other = row => stored(row.lowId) === actorId ? stored(row.highId) : stored(row.lowId);
            const peerIds = [...new Set([...friends.map(other), ...invitations.map(other), ...blocks.map(row => stored(row.blockedId))])];
            if (peerIds.length) {
                const peers = await this.Account.findAll({ where: { id: { [Op.in]: peerIds } }, attributes: PROFILE,
                    limit: peerIds.length, transaction, raw: true });
                for (const peer of peers) { accounts.set(stored(peer.id), peer); }
                if (peers.length !== peerIds.length) { fail('ACCOUNT_NOT_FOUND'); }
            }
            // Do not enumerate everyone who blocked the viewer. Query only visible candidate peers.
            const reverseBlocks = peerIds.length ? await M.SocialBlock.findAll({ where: {
                blockedId: actorId, accountId: { [Op.in]: peerIds }
            }, limit: peerIds.length, transaction, raw: true }) : [];
            const excluded = new Set([...blocks.map(row => stored(row.blockedId)), ...reverseBlocks.map(row => stored(row.accountId))]);
            const byNote = new Map(notes.map(row => [stored(row.friendId), row.note]));
            const viewer = accounts.get(actorId);
            const projectedInvitations = invitations.filter(row => !excluded.has(other(row))).map(row => ({
                invitationId: stored(row.id, MAX_COUNTER), senderId: stored(row.senderId), recipientId: stored(row.recipientId),
                kind: row.kind, message: row.message, createdAt: row.createdAt,
                peer: profile(viewer, accounts.get(other(row))) // Pending Real ID consent never grants names.
            }));
            return {
                accountId: actorId, revision: revision(state?.revision),
                friends: friends.filter(row => !excluded.has(other(row))).map(row => ({
                    ...profile(viewer, accounts.get(other(row)), row.kind), note: byNote.get(other(row)) || ''
                })),
                receivedInvitations: projectedInvitations.filter(row => row.recipientId === actorId),
                sentInvitations: projectedInvitations.filter(row => row.senderId === actorId),
                blocks: blocks.map(row => ({ accountId: stored(row.blockedId), battleTag: accounts.get(stored(row.blockedId)).battleTag }))
            };
        });
    }

    // Publication is at-least-once. Publish each payload with accountId:revision as its deduplication key,
    // confirm with the broker, THEN acknowledge. Never send these internal payloads directly to clients.
    async pendingOutbox(limit = 100) {
        if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200) { fail('INVALID_LIMIT'); }
        const rows = await this.models.SocialOutbox.findAll({ where: { publishedAt: null }, limit,
            order: [['createdAt', 'ASC'], ['accountId', 'ASC'], ['revision', 'ASC']], raw: true });
        return rows.map(row => ({ accountId: stored(row.accountId), revision: revision(row.revision), payload: json(row.payload) }));
    }

    async acknowledgeOutbox(events) {
        if (!Array.isArray(events) || !events.length || events.length > 200) { fail('INVALID_LIMIT'); }
        const keys = events.map(event => ({ accountId: id(event.accountId), revision: id(event.revision, MAX_COUNTER) }));
        const [count] = await this.models.SocialOutbox.update({ publishedAt: this.now() }, {
            where: { publishedAt: null, [Op.or]: keys }
        });
        return count;
    }
}

module.exports = { SocialGraph, LIMITS, assertBlockCapacity };
