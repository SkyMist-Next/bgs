'use strict';

const Service = require('./service');
const wire = require('../social/wire');
const friends = require('../social/friends-wire');
const { registerSocialHandlers } = require('../social/errors');

class UserManagerService extends Service {
    constructor({ logger, models, runtime }) {
        super('UserManagerService', 'proto/bgs/low/pb/client/user_manager_service.proto', { logger });
        this.models = models;
        this.runtime = runtime;
        this.graph = runtime.graph;
        runtime.register('blocks', {
            snapshot: session => this.snapshot(session), diff: friends.blocksDiff
        });
        registerSocialHandlers(this, ['Subscribe', 'Unsubscribe', 'BlockPlayer', 'UnblockPlayer', 'BlockPlayerForSession'], 'blocks');
    }

    async snapshot(session) {
        const snapshot = await this.graph.snapshot(session.accountId);
        const blocked = new Map(snapshot.blocks.map(value => [value.accountId, value]));
        for (const value of await session.sessionBlocks()) { blocked.set(value.accountId, value); }
        return { accountId: session.accountId, revision: snapshot.revision,
            blocks: [...blocked.values()].sort((a, b) => BigInt(a.accountId) < BigInt(b.accountId) ? -1 : 1) };
    }

    async Subscribe(context) {
        const session = await friends.sessionFor(this.runtime, this.models, context);
        const objectId = wire.uint64(context.request.objectId);
        const snapshot = await this.snapshot(session);
        await session.subscribe('blocks', session.accountId, objectId, {}, snapshot);
        context.response.blockedPlayers = snapshot.blocks.map(value => friends.blocked(value));
        return 0;
    }

    async Unsubscribe(context) {
        const session = await friends.sessionFor(this.runtime, this.models, context);
        const objectId = Object.hasOwn(context.request, 'objectId') ? wire.uint64(context.request.objectId) : undefined;
        await session.unsubscribe('blocks', session.accountId, objectId);
        return 0;
    }

    async _change(context, action) {
        const session = await friends.sessionFor(this.runtime, this.models, context);
        if (Object.hasOwn(context.request, 'role')) { friends.kind(context.request.role); }
        const result = await this.graph[action]({ actorId: session.accountId, targetId: wire.accountId(context.request.targetId),
            operationId: session.operationId() });
        if (action === 'unblock') { await session.unblockForSession(wire.accountId(context.request.targetId)); }
        friends.reconcile(this.runtime, result, context);
        return 0;
    }

    BlockPlayer(context) { return this._change(context, 'block'); }
    UnblockPlayer(context) { return this._change(context, 'unblock'); }

    async BlockPlayerForSession(context) {
        const session = await friends.sessionFor(this.runtime, this.models, context);
        const target = wire.accountId(context.request.targetId);
        if (Object.hasOwn(context.request, 'role')) { friends.kind(context.request.role); }
        await session.blockForSession(target);
        friends.deferReconcile(this.runtime, [session.accountId], context);
        return 0;
    }
}

module.exports = UserManagerService;
