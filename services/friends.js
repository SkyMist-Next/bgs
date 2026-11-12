'use strict';

const { Op, QueryTypes } = require('sequelize');
const Service = require('./service');
const wire = require('../social/wire');
const friends = require('../social/friends-wire');
const { jsonColumn } = require('../utils/json-column');
const { registerSocialHandlers } = require('../social/errors');

class FriendsService extends Service {
    constructor({ logger, models, runtime }) {
        super('FriendsService', 'proto/bgs/low/pb/client/friends_service.proto', { logger });
        this.models = models;
        this.runtime = runtime;
        this.graph = runtime.graph;
        runtime.register('friends', {
            snapshot: async owner => this.graph.snapshot(owner.accountId), diff: friends.friendsDiff
        });
        registerSocialHandlers(this, ['Subscribe', 'Unsubscribe', 'SendInvitation', 'AcceptInvitation', 'RevokeInvitation',
            'DeclineInvitation', 'IgnoreInvitation', 'RemoveFriend', 'UpdateFriendState', 'GetFriendList', 'ViewFriends', 'CreateFriendship']);
    }

    async Subscribe(context) {
        const owner = await friends.ownerFor(this.runtime, this.models, context);
        const objectId = wire.uint64(context.request.objectId);
        const snapshot = await this.graph.snapshot(owner.accountId);
        await this.runtime.subscribe(context, owner, 'friends', owner.accountId, objectId, {}, snapshot);
        Object.assign(context.response, friends.subscribe(snapshot, this.graph.limits));
        return 0;
    }

    async Unsubscribe(context) {
        const owner = await friends.ownerFor(this.runtime, this.models, context);
        const objectId = Object.hasOwn(context.request, 'objectId') ? wire.uint64(context.request.objectId) : undefined;
        await this.runtime.unsubscribe(owner, 'friends', owner.accountId, objectId);
        return 0;
    }

    async _target(request, parameters) {
        const email = Object.hasOwn(parameters, 'targetEmail');
        const battleTag = Object.hasOwn(parameters, 'targetBattleTag');
        if (email && battleTag) { throw 0x7; }
        const low = wire.uint64(request.targetId?.low);
        const high = wire.uint64(request.targetId?.high);
        if (low !== '0') {
            if (email || battleTag) { throw 0x7; }
            return { accountId: wire.accountId(request.targetId), expectedKind: null };
        }
        if ((high !== '0' && high !== wire.ACCOUNT_HIGH) || (!email && !battleTag)) { throw 0x14; }
        let rows;
        if (email) {
            const value = wire.text(parameters.targetEmail, 254);
            if (!/^[^\s@]+@[^\s@]+$/.test(value)) { throw 0x7; }
            rows = await this.models.Account.findAll({ where: { email: value }, attributes: ['id'], limit: 2, raw: true });
        }
        else {
            const value = wire.text(parameters.targetBattleTag, 1020);
            if (!/^[^#\s]+#[0-9]+$/.test(value)) { throw 0x7; }
            // Use the migration's full-byte, case-insensitive unique key, not a prefix or accent-folding collation.
            rows = await this.models.sequelize.query(`SELECT CAST(id AS CHAR) AS id FROM accounts
                WHERE battle_tag_case_key = CAST(LOWER(CONVERT(:battleTag USING utf8mb4)) AS BINARY) LIMIT 2`, {
                replacements: { battleTag: value }, type: QueryTypes.SELECT
            });
        }
        if (rows.length !== 1) { throw 0x14; }
        return { accountId: friends.storedId(rows[0].id), expectedKind: email ? 'real_id' : 'battle_tag' };
    }

    async SendInvitation(context) {
        const owner = await friends.ownerFor(this.runtime, this.models, context);
        const params = context.request.params;
        if (!params) { throw 0xBC5; }
        const fields = params[friends.PARAMS] || {};
        if (fields.attribute?.length) { throw 0x7; }
        const roles = fields.role || [];
        if (roles.length > 1) { throw 0x1393; }
        const suppliedKind = roles.length ? friends.kind(roles[0]) : null;
        const target = await this._target(context.request, fields);
        const kind = suppliedKind || target.expectedKind || 'real_id';
        if (target.expectedKind && target.expectedKind !== kind) { throw 0x1393; }
        const result = await this.graph.invite({ actorId: owner.accountId, targetId: target.accountId,
            operationId: this.runtime.operationId(context), kind, message: params.invitationMessage || '' });
        friends.reconcile(this.runtime, result, context);
        return 0;
    }

    async _invitation(owner, invitationId, operationId) {
        const row = await this.models.SocialInvitation.findOne({ where: { id: invitationId,
            [Op.or]: [{ senderId: owner.accountId }, { recipientId: owner.accountId }] }, raw: true });
        if (row) {
            const senderId = friends.storedId(row.senderId); const recipientId = friends.storedId(row.recipientId);
            if (senderId !== owner.accountId && recipientId !== owner.accountId) { throw 0xBC1; }
            return { targetId: senderId === owner.accountId ? recipientId : senderId, kind: row.kind };
        }
        // Acceptance/removal deletes the pending row. Recover the peer from this actor's durable receipt
        // so a transport retry can reach Graph's request-hash check and return the original result.
        const receipt = await this.models.SocialMutation.findOne({ where: { accountId: owner.accountId, operationId }, raw: true });
        const result = jsonColumn(receipt?.result);
        if (result?.invitationId === invitationId && Object.hasOwn(result.revisions || {}, owner.accountId)) {
            const peers = Object.keys(result.revisions).filter(id => id !== owner.accountId);
            if (peers.length === 1) { return { targetId: wire.id(peers[0]), kind: result.kind }; }
        }
        throw 0x138E;
    }

    async _respond(context, action) {
        const owner = await friends.ownerFor(this.runtime, this.models, context);
        const invitationId = wire.uint64(context.request.invitationId);
        if (invitationId === '0') { throw 0x138E; }
        const operationId = this.runtime.operationId(context);
        const invitation = await this._invitation(owner, invitationId, operationId);
        if (context.request.options && Object.hasOwn(context.request.options, 'role')) {
            const requestedKind = friends.kind(context.request.options.role);
            if (invitation.kind && requestedKind !== invitation.kind) { throw 0x1393; }
        }
        const result = await this.graph[action]({ actorId: owner.accountId, targetId: invitation.targetId, invitationId, operationId });
        friends.reconcile(this.runtime, result, context);
        return 0;
    }

    AcceptInvitation(context) { return this._respond(context, 'accept'); }
    RevokeInvitation(context) { return this._respond(context, 'revoke'); }
    DeclineInvitation(context) { return this._respond(context, 'decline'); }
    IgnoreInvitation(context) { return this._respond(context, 'decline'); }

    async RemoveFriend(context) {
        const owner = await friends.ownerFor(this.runtime, this.models, context);
        const result = await this.graph.remove({ actorId: owner.accountId, targetId: wire.accountId(context.request.targetId),
            operationId: this.runtime.operationId(context) });
        friends.reconcile(this.runtime, result, context);
        return 0;
    }

    async UpdateFriendState(context) {
        const owner = await friends.ownerFor(this.runtime, this.models, context);
        const attrs = context.request.attribute || [];
        if (attrs.length !== 1 || attrs[0].name !== 'friend_note' || !attrs[0].value ||
            Object.keys(attrs[0].value).length !== 1 || !Object.hasOwn(attrs[0].value, 'stringValue')) { throw 0x7; }
        const result = await this.graph.setNote({ actorId: owner.accountId, targetId: wire.accountId(context.request.targetId),
            operationId: this.runtime.operationId(context), note: attrs[0].value.stringValue });
        friends.reconcile(this.runtime, result, context);
        return 0;
    }

    async GetFriendList(context) {
        const owner = await friends.ownerFor(this.runtime, this.models, context);
        context.response.friends = (await this.graph.snapshot(owner.accountId)).friends.map(value => friends.friend(value));
        return 0;
    }

    async ViewFriends(context) {
        const owner = await friends.ownerFor(this.runtime, this.models, context);
        const target = wire.accountId(context.request.targetId);
        if (target === owner.accountId) {
            context.response.friends = (await this.graph.snapshot(owner.accountId)).friends.map(value => ({
                accountId: wire.account(value.accountId), role: [friends.role(value.kind)], battleTag: value.battleTag,
                ...(value.realIdVisible ? { fullName: value.fullName } : {})
            }));
        }
        else {
            await this.graph.assertAccess(owner.accountId, target, 'presence');
            // AccountService currently advertises hidden friend-finder profiles and no ViewFriends Real ID
            // visibility. Never reuse the target's own snapshot: it would disclose third-party relationships/names.
            context.response.friends = [];
        }
        return 0;
    }

    async CreateFriendship(context) {
        await friends.ownerFor(this.runtime, this.models, context);
        for (const role of context.request.role || []) { friends.kind(role); }
        throw 0xBC1; // This privileged shortcut must never bypass invitation consent.
    }
}

module.exports = FriendsService;
