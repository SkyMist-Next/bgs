'use strict';

const { jsonColumn: json } = require('../utils/json-column');
const { randomUUID, createHash } = require('node:crypto');
const { Op, Transaction } = require('sequelize');
const { blocked, checkIP } = require('../utils/admin-state');
const { ClientSessions, eligibleGame } = require('../utils/client-sessions');
const { requireProof, wireProof } = require('../utils/authenticator');
const { SocialGraph, LIMITS, assertBlockCapacity } = require('./graph');
const { uint64, id } = require('./wire');
const { WorldSessionLeases, sameWorld } = require('../realm/sessions');
const { SocialSession } = require('./session');
const { SocialError } = require('./errors');
const trusted = Symbol('authenticated world social route');
// Graph caps include 200 notes/invitations and escaped UTF-8 text; an entire authorized
// snapshot can exceed the single-frame limit. Individual wire frames remain capped separately.
const SNAPSHOT_BYTES = 4 * 1024 * 1024;
const DIFF_FRAMES = 2048;
function worldRoute(owner, queueName) {
    if (typeof owner.routeEpoch !== 'string' || uint64(owner.routeEpoch) === '0' ||
        typeof owner.generation !== 'string' || uint64(owner.generation) === '0' ||
        typeof owner.session_id !== 'string' || !owner.session_id ||
        typeof queueName !== 'string' || !/^[\x21-\x7E]{1,255}$/.test(queueName)) { throw 0xBC5; }
    id(owner.account_id); id(owner.game_account_id);
    if (!/^[\x21-\x7E]{1,80}$/.test('w:' + owner.session_id + ':' + owner.generation)) { throw 0xBC5; }
    return { type: 'world', owner: { ...owner }, queueName };
}
function validateSessionKey(value) {
    if (typeof value !== 'string' || !/^[\x21-\x7E]{1,80}$/.test(value)) { throw 0x7; }
    return value;
}

class SocialRuntime {
    constructor(dependencies) {
        Object.assign(this, dependencies);
        this.leases = new WorldSessionLeases(this.store, this.models);
        this.sessions = new ClientSessions(this.store, this.models);
        this.graph = new SocialGraph({ sequelize: this.models.sequelize, Account: this.models.Account, models: this.models });
        this.projectors = new Map(); this.cursor = ''; this.blockCursor = ''; this.routeCursor = ''; this.stopping = false;
    }
    // A projector turns one subscription kind into snapshots and diff frames; its optional
    // cleanup(limit) runs once per reconciliation pulse.
    register(kind, projector) { this.projectors.set(kind, projector); }
    worldContext(context, owner, queueName) {
        context[trusted] = { ...owner, sessionKey: 'w:' + owner.session_id + ':' + owner.generation,
            accountId: owner.account_id, gameAccountId: owner.game_account_id, applicationVersion: owner.build,
            route: worldRoute(owner, queueName) };
    }
    async refreshWorldRoute(owner, queueName) {
        // SocialRealm calls only after realm authorization and the Redis lease fence.
        const route = worldRoute(owner, queueName), accountId = owner.account_id, gameAccountId = owner.game_account_id;
        const sessionKey = 'w:' + owner.session_id + ':' + owner.generation;
        return this.models.sequelize.transaction({ isolationLevel: Transaction.ISOLATION_LEVELS.READ_COMMITTED }, async transaction => {
            await this.models.Account.findByPk(accountId, { transaction, lock: transaction.LOCK.UPDATE });
            if (!await this.current(route, accountId, transaction)) { throw 0xA; }
            const existing = await this.models.SocialWorldRoute.findOne({ where: { sessionKey }, transaction, raw: true });
            if (existing) {
                const previous = json(existing.route);
                if (String(existing.accountId) !== accountId || String(existing.gameAccountId) !== gameAccountId ||
                    !sameWorld(previous.owner, owner) || BigInt(existing.routeEpoch) > BigInt(owner.routeEpoch) ||
                    (String(existing.routeEpoch) === owner.routeEpoch && previous.queueName !== queueName)) { throw 0xA; }
                if (String(existing.routeEpoch) === owner.routeEpoch) { return { changed: false, sessionKey, routeEpoch: owner.routeEpoch, queueName }; }
            } else if (await this.models.SocialWorldRoute.count({ where: { accountId }, transaction }) >= 1024) { throw 0xBC6; }
            const where = { sessionKey, accountId, gameAccountId };
            const rows = await this.models.SocialSubscription.findAll({ where, order: [['id', 'ASC']], limit: 1025, transaction, raw: true });
            if (rows.length > 1024) { throw 0xBC6; }
            for (const row of rows) {
                const previous = json(row.route);
                if (previous.type !== 'world' || !sameWorld(previous.owner, owner)) { throw 0xA; }
                await this.models.SocialSubscription.update({ route, ...(row.kind === 'presence' ? { snapshot: null } : {}) },
                    { where: { id: row.id, ...where }, transaction });
            }
            const value = { sessionKey, accountId, gameAccountId, routeEpoch: owner.routeEpoch, route };
            if (existing) { await this.models.SocialWorldRoute.update(value, { where: { id: existing.id }, transaction }); }
            else { await this.models.SocialWorldRoute.create({ id: randomUUID(), ...value }, { transaction }); }
            return { changed: true, sessionKey, routeEpoch: owner.routeEpoch, queueName };
        });
    }
    async worldRouteCurrent(route, accountId, transaction) {
        if (route.type !== 'world') { return true; }
        const owner = route.owner;
        const row = await this.models.SocialWorldRoute.findOne({ where: {
            sessionKey: 'w:' + owner.session_id + ':' + owner.generation, accountId, gameAccountId: owner.game_account_id
        }, transaction, raw: true });
        if (!row || String(row.routeEpoch) !== owner.routeEpoch) { return false; }
        const current = json(row.route);
        return current.queueName === route.queueName && sameWorld(current.owner, owner);
    }
    async cleanupWorldRoutes(limit = 20) {
        if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) { throw 0x7; }
        const rows = await this.models.SocialWorldRoute.findAll({ where: { id: { [Op.gt]: this.routeCursor } },
            order: [['id', 'ASC']], limit, raw: true });
        for (const row of rows) {
            await this.models.sequelize.transaction(async transaction => {
                // Match refresh lock order. A live lease retains its fence even with zero subscriptions.
                await this.models.Account.findByPk(String(row.accountId), { transaction, lock: transaction.LOCK.UPDATE });
                if (!await this.worldLease(json(row.route), transaction)) {
                    await this.models.SocialWorldRoute.destroy({ where: { id: row.id }, transaction });
                }
            });
            this.routeCursor = row.id;
        }
        if (rows.length < limit) { this.routeCursor = ''; }
    }
    // The calling RPC's social session: a trusted world route or the client session.
    async session(context) {
        let owner = context[trusted];
        if (!owner) {
            const client = await this.sessions.resolve(context);
            owner = { ...client, sessionKey: 'c:' + client.connectionId,
                route: { type: 'connection', connectionId: client.connectionId, address: client.address, queueName: context.queueName } };
        }
        id(owner.accountId);
        return new SocialSession(this, owner, context);
    }
    async selectGame(owner, gameAccountId) {
        const selected = id(gameAccountId);
        if (owner.gameAccountId && owner.gameAccountId !== selected) { throw 0xA; }
        if (owner.route?.type === 'world') {
            // A world session is already bound to its leased license; it must still be eligible and current.
            await this.sessions.ownedGame(owner, selected);
            if (owner.gameAccountId !== selected || !(await this.current(owner.route, owner.accountId))) { throw 0xA; }
            return owner;
        }
        if (owner.route?.type !== 'connection' || owner.sessionKey !== 'c:' + owner.route.connectionId) { throw 0xA; }
        owner.gameAccountId = (await this.sessions.selectGame(owner, selected)).gameAccountId;
        return owner;
    }
    operationId(context) {
        const session = context[trusted]?.sessionKey || context.identity?.connectionId;
        if (!session) { throw 0xA; }
        return createHash('sha256').update(JSON.stringify([session, context.requestId || '',
            context.header.serviceHash, context.header.methodId, context.header.token])).digest('hex');
    }
    worldLease(route, transaction) {
        return this.leases.live(route.owner.game_account_id, { expected: route.owner, transaction });
    }
    async current(route, accountId, transaction) {
        if (route.type === 'connection') {
            const session = await this.sessions.current(route.connectionId, { accountId, address: route.address }, transaction);
            return session && new SocialSession(this, { ...session, sessionKey: 'c:' + route.connectionId, route });
        }
        if (route.type !== 'world') { return null; }
        const expected = route.owner;
        const actual = await this.worldLease(route, transaction);
        if (!actual || actual.account_id !== accountId) { return null; }
        const game = await this.models.GameAccount.findByPk(actual.game_account_id, { transaction });
        if (!eligibleGame(game, actual.build) || String(game.accountId) !== accountId || game.program !== 'WoW') { return null; }
        let proof;
        try { proof = wireProof(actual); } catch { return null; }
        const owner = { ...actual, ...proof, routeEpoch: expected.routeEpoch, accountId, gameAccountId: actual.game_account_id,
            applicationVersion: actual.build, sessionKey: 'w:' + actual.session_id + ':' + actual.generation, route };
        const account = await this.models.Account.findByPk(accountId, { transaction });
        if (blocked(account)) { return null; }
        try { requireProof(account, owner); } catch { return null; }
        // A database outage is not an authentication revocation: retain the subscription for recovery.
        try { await checkIP(this.models, owner.address, Date.now(), { transaction }); }
        catch (error) { if (error === 0xA) { return null; } throw error; }
        return new SocialSession(this, owner);
    }
    async blockSession(owner, targetId) {
        id(owner.accountId); id(targetId);
        if (targetId === owner.accountId) { throw 0x1F42; }
        validateSessionKey(owner.sessionKey);
        const current = await this.current(owner.route, owner.accountId);
        if (!current || current.sessionKey !== owner.sessionKey) { throw 0xA; }
        return this.models.sequelize.transaction({ isolationLevel: Transaction.ISOLATION_LEVELS.READ_COMMITTED }, async transaction => {
            const account = await this.models.Account.findByPk(owner.accountId, { transaction, lock: transaction.LOCK.UPDATE });
            if (blocked(account)) { throw 0xA; }
            if (!await this.models.Account.findByPk(targetId, { transaction })) { throw 0x14; }
            const where = { sessionKey: owner.sessionKey, blockedAccountId: targetId };
            if (await this.models.SocialSessionBlock.findOne({ where, transaction })) { return false; }
            try { await assertBlockCapacity(this.models, owner.accountId, targetId, transaction); }
            catch (error) { if (error.code === 'BLOCK_LIMIT') { throw 0x1F45; } throw error; }
            await this.models.SocialSessionBlock.create({ id: randomUUID(), ...where, accountId: owner.accountId,
                route: owner.route, createdAt: new Date() }, { transaction });
            return true;
        });
    }
    async unblockSession(owner, targetId) {
        id(targetId);
        const current = await this.current(owner.route, owner.accountId);
        if (!current || current.sessionKey !== owner.sessionKey) { throw 0xA; }
        return Boolean(await this.models.SocialSessionBlock.destroy({ where: {
            accountId: owner.accountId, sessionKey: owner.sessionKey, blockedAccountId: targetId
        } }));
    }
    async sessionBlocked(sessionKey, otherAccountId) {
        // Session keys are internal authenticated identifiers, not Sequelize predicates.
        validateSessionKey(sessionKey);
        id(otherAccountId);
        const row = await this.models.SocialSessionBlock.findOne({ where: { sessionKey, blockedAccountId: otherAccountId }, raw: true });
        if (!row) { return false; }
        const owner = await this.current(json(row.route), String(row.accountId));
        return Boolean(owner && owner.sessionKey === sessionKey);
    }
    async sessionBlocks(owner) {
        const current = await this.current(owner.route, owner.accountId);
        if (!current || current.sessionKey !== owner.sessionKey) { throw 0xA; }
        const rows = await this.models.SocialSessionBlock.findAll({ where: { sessionKey: owner.sessionKey, accountId: owner.accountId },
            order: [['blockedAccountId', 'ASC']], limit: LIMITS.blocks + 1, raw: true });
        if (rows.length > LIMITS.blocks) { throw 0x1F45; }
        if (!rows.length) { return []; }
        const profiles = await this.models.Account.findAll({ where: { id: { [Op.in]: rows.map(row => String(row.blockedAccountId)) } },
            attributes: ['id', 'battleTag'], limit: 500, raw: true });
        return profiles.map(profile => ({ accountId: String(profile.id), battleTag: profile.battleTag }));
    }
    async cleanupSessionBlocks(limit = 20) {
        if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) { throw 0x7; }
        const rows = await this.models.SocialSessionBlock.findAll({ where: { id: { [Op.gt]: this.blockCursor } },
            order: [['id', 'ASC']], limit, raw: true });
        for (const row of rows) {
            const owner = await this.current(json(row.route), String(row.accountId));
            if (!owner || owner.sessionKey !== row.sessionKey) {
                await this.models.SocialSessionBlock.destroy({ where: { id: row.id, sessionKey: row.sessionKey } });
            }
            this.blockCursor = row.id;
        }
        if (rows.length < limit) { this.blockCursor = ''; }
    }
    async subscribe(context, owner, kind, target, objectId, filter = {}, snapshot = null) {
        if (!this.projectors.has(kind) || typeof target !== 'string' || target.length > 64 ||
            Buffer.byteLength(JSON.stringify(filter)) > 16384 || Buffer.byteLength(JSON.stringify(snapshot)) > SNAPSHOT_BYTES) { throw 0xBC5; }
        const key = { sessionKey: owner.sessionKey, kind, target, objectId: uint64(objectId) };
        const row = await this.models.sequelize.transaction(async transaction => {
            // One session cannot race its subscription capacity across worker replicas.
            await this.models.Account.findByPk(owner.accountId, { transaction, lock: transaction.LOCK.UPDATE });
            if (!await this.worldRouteCurrent(owner.route, owner.accountId, transaction)) { throw 0xA; }
            const existing = await this.models.SocialSubscription.findOne({ where: key, transaction });
            if (!existing && await this.models.SocialSubscription.count({ where: { sessionKey: owner.sessionKey }, transaction }) >= 1024) { throw 0xBC6; }
            const value = { ...key, accountId: owner.accountId, gameAccountId: owner.gameAccountId || null,
                route: owner.route, filter, snapshot, ready: false, expiresAt: new Date(Date.now() + 300000) };
            // Each Subscribe attempt gets a new row identity. A late afterReply from an older request
            // must not make the replacement snapshot ready before its own response was published.
            if (existing) { await this.models.SocialSubscription.destroy({ where: { id: existing.id }, transaction }); }
            return (await this.models.SocialSubscription.create({ id: randomUUID(), ...value }, { transaction })).get({ plain: true });
        });
        const after = context.afterReply;
        context.afterReply = async () => {
            await after?.();
            await this.models.sequelize.transaction(async transaction => {
                await this.models.Account.findByPk(owner.accountId, { transaction, lock: transaction.LOCK.UPDATE });
                if (await this.worldRouteCurrent(owner.route, owner.accountId, transaction)) {
                    await this.models.SocialSubscription.update({ ready: true }, { where: { id: row.id, sessionKey: owner.sessionKey }, transaction });
                }
            });
        };
        return row;
    }
    async unsubscribe(owner, kind, target, objectId) {
        const where = { sessionKey: owner.sessionKey, kind };
        if (target !== undefined) { where.target = target; }
        if (objectId !== undefined) { where.objectId = uint64(objectId); }
        await this.models.sequelize.transaction(async transaction => {
            await this.models.Account.findByPk(owner.accountId, { transaction, lock: transaction.LOCK.UPDATE });
            if (!await this.worldRouteCurrent(owner.route, owner.accountId, transaction)) { throw 0xA; }
            await this.models.SocialSubscription.destroy({ where, transaction });
        });
    }
    async start(realmConnection = this.amqpConnection) {
        const failed = error => {
            if (this.stopping || this.channelFailed) { return; }
            this.channelFailed = true;
            const reason = error instanceof Error ? error : new Error('Social notification channel closed');
            // Do not await server shutdown from the publisher/reconciliation path it must drain.
            void Promise.resolve().then(() => this.onChannelFailure?.(reason))
                .catch(() => this.logger.warn('Social notification channel shutdown failed'));
        };
        const watch = channel => { channel.on('error', failed); channel.on('close', failed); };
        this.channel = await this.amqpConnection.createConfirmChannel();
        watch(this.channel);
        this.realmChannel = realmConnection === this.amqpConnection ? this.channel : await realmConnection.createConfirmChannel();
        if (this.realmChannel !== this.channel) { watch(this.realmChannel); }
        this.schedule();
    }
    async notify(row, frames) {
        if (this.stopping || this.channelFailed) { throw new Error('Social notification channel unavailable'); }
        const route = json(row.route);
        const payloadLimit = route.type === 'world' ? 65536 : 262144;
        if (!await this.current(route, String(row.accountId)) || !await this.worldRouteCurrent(route, String(row.accountId))) { return false; }
        for (const frame of frames) {
            if (this.stopping || this.channelFailed) { throw new Error('Social notification channel unavailable'); }
            if (!await this.current(route, String(row.accountId)) || !await this.worldRouteCurrent(route, String(row.accountId))) { return false; }
            if (!Buffer.isBuffer(frame.payload) || frame.payload.length > payloadLimit) { throw new Error('Social notification exceeds limit'); }
            let payload = frame.payload;
            let options = { type: 'request', expiration: '15000', persistent: false, headers: {
                serviceHash: frame.serviceHash, methodId: frame.methodId, objectId: frame.objectId,
                serviceId: 0, status: 0, size: payload.length
            } };
            if (route.type === 'world') {
                const owner = route.owner;
                payload = Buffer.from(JSON.stringify({ version: 1, game_account_id: owner.game_account_id,
                    session_id: owner.session_id, generation: owner.generation, service_hash: frame.worldHash,
                    method_id: frame.methodId, object_id: frame.objectId, payload: payload.toString('base64') }));
                options = { type: 'social.notification', contentType: 'application/json', expiration: '15000', persistent: false };
            }
            await new Promise((resolve, reject) => {
                const timer = setTimeout(() => reject(new Error('Social notification confirmation timed out')), 2000);
                const channel = route.type === 'world' ? this.realmChannel : this.channel;
                try {
                    channel.sendToQueue(route.queueName, payload, options, error => {
                        clearTimeout(timer); if (error) { reject(error); } else { resolve(); }
                    });
                } catch (error) { clearTimeout(timer); reject(error); }
            });
        }
        return true;
    }
    // Live-only delivery of one whisper to every live social session of the target that
    // listens to friends. False when it reached no one: either side's block, missing
    // friendship policy, no live recipient or no confirmed publication. buildFrame runs
    // once, only after a recipient is known. Dependency and publisher failures propagate;
    // nothing is queued, retried or kept as history.
    async whisper(sender, targetId, buildFrame) {
        const senderId = id(sender.accountId); id(targetId);
        if (await this.sessionBlocked(sender.sessionKey, targetId)) { return false; }
        try { await this.graph.assertAccess(senderId, targetId, 'whisper'); }
        catch (error) { if (error instanceof SocialError) { return false; } throw error; }
        const recipients = [], seen = new Set();
        for (const row of await this.recipients(targetId, 'friends')) {
            if (String(row.accountId) !== targetId) { continue; }
            const peer = await this.current(json(row.route), targetId);
            if (!peer || peer.accountId !== targetId) { continue; }
            if (!peer.sessionKey) { throw new Error('Whisper recipient has no authenticated session'); }
            // Friends can have several listener objects on one session; NotificationListener
            // is global, so fan out only once to that session.
            if (seen.has(peer.sessionKey)) { continue; }
            seen.add(peer.sessionKey);
            if (!await this.sessionBlocked(peer.sessionKey, senderId)) { recipients.push(row); }
        }
        if (!recipients.length) { return false; }
        const frame = await buildFrame();
        let sent = false;
        for (const recipient of recipients) { sent = await this.notify(recipient, [frame]) || sent; }
        return sent;
    }
    async recipients(accountId, kind) {
        const rows = await this.models.SocialSubscription.findAll({ where: { accountId, kind, ready: true }, limit: 65, raw: true });
        if (rows.length > 64) { throw 0xBC6; }
        const result = [];
        for (const row of rows) { if (await this.current(json(row.route), accountId)) { result.push(row); } }
        return result;
    }
    async reconcileRow(subscriptionId) {
        return this.models.sequelize.transaction(async transaction => {
            const row = await this.models.SocialSubscription.findOne({ where: { id: subscriptionId, ready: true },
                transaction, lock: transaction.LOCK.UPDATE, skipLocked: true, raw: true });
            if (!row) { return; }
            const owner = await this.current(json(row.route), String(row.accountId));
            if (!owner) { await this.models.SocialSubscription.destroy({ where: { id: row.id }, transaction }); return; }
            const projector = this.projectors.get(row.kind);
            if (!projector) { return; }
            const snapshot = await projector.snapshot(owner, { ...row, filter: json(row.filter) });
            if (Buffer.byteLength(JSON.stringify(snapshot)) > SNAPSHOT_BYTES) { throw new Error('Social snapshot exceeds limit'); }
            const previous = json(row.snapshot);
            if (JSON.stringify(previous) !== JSON.stringify(snapshot)) {
                const frames = projector.diff(previous, snapshot, row);
                if (frames.length > DIFF_FRAMES) { throw new Error('Social snapshot event limit exceeded'); }
                if (!await this.notify(row, frames)) {
                    await this.models.SocialSubscription.destroy({ where: { id: row.id }, transaction });
                    return;
                }
            }
            await this.models.SocialSubscription.update({ snapshot, expiresAt: new Date(Date.now() + 300000) }, { where: { id: row.id }, transaction });
        });
    }
    async reconcile(accountId) {
        const rows = await this.models.SocialSubscription.findAll({ where: { accountId, kind: { [Op.in]: ['friends', 'blocks'] }, ready: true },
            attributes: ['id'], limit: 129, raw: true });
        if (rows.length > 128) { throw new Error('Social session limit exceeded'); }
        for (const row of rows) { await this.reconcileRow(row.id); }
    }
    async pulse() {
        for (const projector of this.projectors.values()) { await projector.cleanup?.(20); }
        await this.cleanupWorldRoutes(20);
        await this.cleanupSessionBlocks(20);
        const events = await this.graph.pendingOutbox(20);
        for (const accountId of new Set(events.map(event => event.accountId))) { await this.reconcile(accountId); }
        if (events.length) { await this.graph.acknowledgeOutbox(events); }
        const rows = await this.models.SocialSubscription.findAll({ where: { id: { [Op.gt]: this.cursor }, ready: true },
            attributes: ['id'], order: [['id', 'ASC']], limit: 20, raw: true });
        for (const row of rows) { await this.reconcileRow(row.id); }
        this.cursor = rows.length === 20 ? rows.at(-1).id : '';
        await this.models.SocialSubscription.destroy({ where: { expiresAt: { [Op.lt]: new Date() } }, limit: 100 });
    }
    schedule() {
        if (this.stopping) { return; }
        this.timer = setTimeout(() => {
            this.running = this.pulse().catch(() => { this.logger.warn('Social reconciliation deferred'); })
                .finally(() => { this.running = null; this.schedule(); });
        }, this.cursor ? 50 : 500);
        this.timer.unref();
    }
    stop() {
        this.stopping = true; clearTimeout(this.timer);
        this.stopTask ??= (async () => {
            await this.running;
            const channels = [...new Set([this.channel, this.realmChannel])].filter(Boolean);
            const results = await Promise.allSettled(channels.map(channel => Promise.resolve().then(() => channel.close())));
            const failed = results.find(result => result.status === 'rejected');
            if (failed) { throw failed.reason; }
        })();
        return this.stopTask;
    }
}
module.exports = SocialRuntime;
