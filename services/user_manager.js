'use strict';

const Service = require('./service');
const wire = require('../social/wire');
const friends = require('../social/friends-wire');

class UserManagerService extends Service {
    constructor({ logger, models, runtime }) {
        super('UserManagerService', 'proto/bgs/low/pb/client/user_manager_service.proto', { logger });
        this.models = models;
        this.runtime = runtime;
        this.graph = runtime.graph;
        runtime.register('blocks', {
            snapshot: owner => this.snapshot(owner), diff: friends.blocksDiff
        });
        for (const name of ['Subscribe', 'Unsubscribe', 'BlockPlayer', 'UnblockPlayer', 'BlockPlayerForSession']) {
            this.registerHandler(name, async context => {
                try { return await this[name](context); }
                catch (error) { throw friends.status(error, 'blocks'); }
            });
        }
    }

    async snapshot(owner) {
        const snapshot = await this.graph.snapshot(owner.accountId);
        const blocked = new Map(snapshot.blocks.map(value => [value.accountId, value]));
        for (const value of await this.runtime.sessionBlocks(owner)) { blocked.set(value.accountId, value); }
        return { accountId: owner.accountId, revision: snapshot.revision,
            blocks: [...blocked.values()].sort((a, b) => BigInt(a.accountId) < BigInt(b.accountId) ? -1 : 1) };
    }

    async Subscribe(context) {
        const owner = await friends.ownerFor(this.runtime, this.models, context);
        const objectId = wire.uint64(context.request.objectId);
        const snapshot = await this.snapshot(owner);
        await this.runtime.subscribe(context, owner, 'blocks', owner.accountId, objectId, {}, snapshot);
        context.response.blockedPlayers = snapshot.blocks.map(value => friends.blocked(value));
        return 0;
    }

    async Unsubscribe(context) {
        const owner = await friends.ownerFor(this.runtime, this.models, context);
        const objectId = Object.hasOwn(context.request, 'objectId') ? wire.uint64(context.request.objectId) : undefined;
        await this.runtime.unsubscribe(owner, 'blocks', owner.accountId, objectId);
        return 0;
    }

    async _change(context, action) {
        const owner = await friends.ownerFor(this.runtime, this.models, context);
        if (Object.hasOwn(context.request, 'role')) { friends.kind(context.request.role); }
        const result = await this.graph[action]({ actorId: owner.accountId, targetId: wire.accountId(context.request.targetId),
            operationId: this.runtime.operationId(context) });
        if (action === 'unblock') { await this.runtime.unblockSession(owner, wire.accountId(context.request.targetId)); }
        friends.reconcile(this.runtime, result, context);
        return 0;
    }

    BlockPlayer(context) { return this._change(context, 'block'); }
    UnblockPlayer(context) { return this._change(context, 'unblock'); }

    async BlockPlayerForSession(context) {
        const owner = await friends.ownerFor(this.runtime, this.models, context);
        const target = wire.accountId(context.request.targetId);
        if (Object.hasOwn(context.request, 'role')) { friends.kind(context.request.role); }
        await this.runtime.blockSession(owner, target);
        friends.deferReconcile(this.runtime, [owner.accountId], context);
        return 0;
    }
}

module.exports = UserManagerService;
