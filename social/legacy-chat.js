'use strict';

const { randomUUID, createHash } = require('node:crypto');
const { Op, Transaction } = require('sequelize');
const Long = require('long');
const FourCC = require('../utils/fourcc');
const loadProto = require('../utils/protobuf');
const { blocked } = require('../utils/admin-state');
const { eligibleGame } = require('../utils/client-sessions');
const WorldPresence = require('./world-presence');
const { validatePresence } = require('./realm-contract');
const { id, uint64, account, hash, text } = require('./wire');

const FILE = 'proto/skymist/legacy_chat.proto';
const NAMESPACE = 'skymist.protocol.legacy_chat.v1.';
const root = loadProto(FILE);
const STATUS = Object.freeze(root.lookupEnum(NAMESPACE + 'LegacyChatStatus').values);
// Admission stops at 64 unacknowledged closures. The six existing groups can
// still close, so snapshots reserve 70 entries without dropping pending events.
// Keep these bounds aligned with compat::social's legacy snapshot contract.
const LIMITS = Object.freeze({ groups: 6, members: 12, messageBytes: 4096, pendingClosures: 64, dedupSeconds: 300 });
const CLOSURE_SNAPSHOT_CAPACITY = LIMITS.pendingClosures + LIMITS.groups;
const json = value => typeof value === 'string' ? JSON.parse(value) : value;
const stored = value => id(String(value));
const counter = value => uint64(String(value));
const sorted = values => [...new Set(values)].sort((a, b) => BigInt(a) < BigInt(b) ? -1 : BigInt(a) > BigInt(b) ? 1 : 0);
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const scope = row => ({ gameAccountId: stored(row.gameAccountId), sessionKey: row.sessionKey, generation: counter(row.generation) });
class LegacyChatError extends Error {
    constructor(name) { super(name); this.name = 'LegacyChatError'; this.status = STATUS[name]; }
}
class TopologyChanged extends Error {}
function fail(name) { throw new LegacyChatError(name); }
function groupId(value) {
    if (typeof value !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value)) { fail('LEGACY_INVALID_INPUT'); }
    return value;
}
function entity(game) {
    const program = new FourCC(game.program).getIntValue();
    return { high: Long.fromBits(program, (2 << 24) | Number(game.region), true), low: Long.fromString(stored(game.id), true) };
}
function sameEntity(left, right) {
    return left && right && left.low?.toString() === right.low?.toString() && left.high?.toString() === right.high?.toString();
}
function frame(methodName, objectId, data) {
    const service = root.lookupService(NAMESPACE + 'LegacyChatListener');
    const method = service.methods[methodName];
    const type = root.lookupType(method.requestType);
    const message = type.fromObject(data);
    const error = type.verify(message);
    if (error) { throw new Error('Invalid legacy callback: ' + error); }
    return { serviceHash: hash(service.getOption('(bgs.protocol.service_options).descriptor_name')),
        worldHash: hash(service.fullName.slice(1)), methodId: method.getOption('(bgs.protocol.method_options).id'),
        objectId: uint64(objectId), payload: Buffer.from(type.encode(message).finish()) };
}

/** SQL is the group authority. Every mutation locks all affected parent accounts
 * individually in canonical numeric order BEFORE reading friendship/block policy.
 * Membership topology is optimistically discovered, then rechecked under those
 * locks; a concurrent change restarts discovery, never adds a lock out of order.
 * No text/history/offline delivery is stored in these tables or receipts.
 */
class LegacyChat {
    constructor(runtime, { now = () => new Date(), uuid = randomUUID, worldPresence } = {}) {
        this.runtime = runtime; this.models = runtime.models; this.now = now; this.uuid = uuid;
        this.worldPresence = worldPresence || runtime.worldPresence || new WorldPresence(runtime.store);
        this.cursor = '0';
        runtime.register('legacy', {
            snapshot: (owner, row) => this.snapshot(owner, row.target, json(row.filter).generation, counter(row.objectId)),
            diff: (before, after, row) => this.diff(before, after, row)
        });
        runtime.legacyChat = this;
    }

    async _game(gameId, transaction, requireAvailable = true) {
        const game = await this.models.GameAccount.findByPk(id(gameId), { transaction, raw: true });
        // Legacy conversations are 15595-only, so members hold Cataclysm licenses.
        if (!eligibleGame(game, 15595, { includeBlocked: !requireAvailable })) { fail('LEGACY_NOT_OWNER'); }
        return game;
    }
    async _actor(context, subscribed = true) {
        if (context.request.version !== 1) { fail('LEGACY_INVALID_VERSION'); }
        const owner = await this.runtime.owner(context);
        if (owner.applicationVersion !== 15595 || owner.route?.type !== 'connection') { fail('LEGACY_UNSUPPORTED_CLIENT'); }
        id(owner.accountId);
        const gameId = id(context.request.gameAccountId?.low);
        if (owner.gameAccountId && owner.gameAccountId !== gameId) { fail('LEGACY_NOT_OWNER'); }
        const game = await this._game(gameId);
        if (stored(game.accountId) !== owner.accountId || !sameEntity(context.request.gameAccountId, entity(game))) { fail('LEGACY_NOT_OWNER'); }
        return { owner: { ...owner, gameAccountId: gameId }, gameId, game,
            generation: subscribed ? uint64(context.request.generation) : null };
    }
    async _members(groups, transaction) {
        if (!groups.length) { return []; }
        const rows = await this.models.SocialLegacyMember.findAll({ where: { groupId: { [Op.in]: groups } },
            order: [['groupId', 'ASC'], ['gameAccountId', 'ASC']], limit: groups.length * LIMITS.members + 1, transaction, raw: true });
        if (rows.length > groups.length * LIMITS.members) { fail('LEGACY_CAPACITY'); }
        return rows;
    }
    async _groupsFor(gameIds, transaction) {
        if (!gameIds.length) { return []; }
        const rows = await this.models.SocialLegacyMember.findAll({ where: { gameAccountId: { [Op.in]: gameIds } },
            attributes: ['groupId'], limit: gameIds.length * LIMITS.groups + 1, transaction, raw: true });
        if (rows.length > gameIds.length * LIMITS.groups) { fail('LEGACY_CAPACITY'); }
        return [...new Set(rows.map(row => row.groupId))].sort();
    }
    async _locked({ gameIds = [], groups = [], expand = [] }, work) {
        for (let attempt = 0; attempt < 4; ++attempt) {
            const discovered = [...new Set([...groups, ...await this._groupsFor(expand)])].sort();
            const members = await this._members(discovered);
            const games = [];
            for (const gameId of sorted(gameIds)) { games.push(await this._game(gameId, undefined, false)); }
            const parents = sorted([...games.map(game => stored(game.accountId)), ...members.map(member => stored(member.accountId))]);
            const signature = rows => JSON.stringify(rows.map(row => [row.groupId, stored(row.gameAccountId), stored(row.accountId), row.sessionKey, counter(row.generation)]));
            try {
                return await this.models.sequelize.transaction({ isolationLevel: Transaction.ISOLATION_LEVELS.READ_COMMITTED }, async transaction => {
                    for (const accountId of parents) {
                        if (!await this.models.Account.findByPk(accountId, { transaction, lock: transaction.LOCK.UPDATE })) { fail('LEGACY_NOT_OWNER'); }
                    }
                    const currentGroups = [...new Set([...groups, ...await this._groupsFor(expand, transaction)])].sort();
                    if (JSON.stringify(currentGroups) !== JSON.stringify(discovered)) { throw new TopologyChanged(); }
                    for (const key of discovered) {
                        await this.models.SocialLegacyGroup.findByPk(key, { transaction, lock: transaction.LOCK.UPDATE });
                    }
                    const currentMembers = await this._members(discovered, transaction);
                    if (signature(currentMembers) !== signature(members)) { throw new TopologyChanged(); }
                    return work({ transaction, members: currentMembers, parents, groups: discovered });
                });
            } catch (error) { if (!(error instanceof TopologyChanged)) { throw error; } }
        }
        fail('LEGACY_OPERATION_CONFLICT');
    }
    async _owner(gameId, transaction) {
        return this.models.SocialLegacyOwner.findByPk(gameId, { transaction, ...(transaction ? { lock: transaction.LOCK.UPDATE } : {}), raw: true });
    }
    async _live(row) {
        if (!row?.active) { return null; }
        const owner = await this.runtime.current(json(row.route), stored(row.accountId));
        return owner?.applicationVersion === 15595 && owner.route?.type === 'connection' && owner.sessionKey === row.sessionKey ? owner : null;
    }
    async _lease(actor, transaction) {
        await this._game(actor.gameId, transaction);
        const row = await this._owner(actor.gameId, transaction);
        if (!row?.active || row.sessionKey !== actor.owner.sessionKey || counter(row.generation) !== actor.generation ||
            stored(row.accountId) !== actor.owner.accountId) { fail('LEGACY_STALE_SESSION'); }
        if (!await this._live(row)) { fail('LEGACY_STALE_SESSION'); }
        return row;
    }
    async _slots(row, transaction) {
        if (await this.models.SocialLegacyMember.count({ where: scope(row), transaction }) >= LIMITS.groups ||
            await this.models.SocialLegacyClosed.count({ where: scope(row), transaction }) >= LIMITS.pendingClosures) { fail('LEGACY_CAPACITY'); }
    }
    async _blocks(parents, transaction) {
        if (parents.length < 2) { return; }
        if (await this.models.SocialBlock.findOne({ where: { accountId: { [Op.in]: parents }, blockedId: { [Op.in]: parents } }, transaction, raw: true })) {
            fail('LEGACY_BLOCKED');
        }
    }
    async _sessionBlocks(participants) {
        const parents = sorted(participants.map(member => stored(member.accountId)));
        const checked = new Set();
        for (const member of participants) {
            for (const parent of parents) {
                const key = member.sessionKey + ':' + parent;
                if (parent === stored(member.accountId) || checked.has(key)) { continue; }
                checked.add(key);
                if (await this.runtime.sessionBlocked(member.sessionKey, parent)) { fail('LEGACY_BLOCKED'); }
            }
        }
    }
    async _friends(actorId, targets) {
        for (const targetId of sorted(targets)) {
            if (actorId === targetId) { fail('LEGACY_NOT_FRIENDS'); }
            try { await this.runtime.graph.assertAccess(actorId, targetId, 'conversation'); }
            catch (error) {
                if (error.code === 'BLOCKED') { fail('LEGACY_BLOCKED'); }
                if (error.code === 'NOT_FRIENDS' || error.code === 'SELF_TARGET') { fail('LEGACY_NOT_FRIENDS'); }
                throw error;
            }
        }
    }
    async _receipt(actor, context, action, input, transaction, work) {
        const operationId = this.runtime.operationId(context);
        if (!/^[0-9a-f]{64}$/.test(operationId)) { throw new Error('Invalid runtime operation ID'); }
        const where = { accountId: actor.owner.accountId, operationId };
        const requestHash = digest({ action, gameId: actor.gameId, sessionKey: actor.owner.sessionKey, generation: actor.generation, input });
        const previous = await this.models.SocialLegacyMutation.findOne({ where, transaction, raw: true });
        if (previous) {
            if (previous.requestHash !== requestHash) { fail('LEGACY_OPERATION_CONFLICT'); }
            return json(previous.result);
        }
        const result = await work();
        await this.models.SocialLegacyMutation.create({ ...where, requestHash, result, createdAt: this.now() }, { transaction });
        return result;
    }
    async _add(group, lease, transaction) {
        await this._slots(lease, transaction);
        await this.models.SocialLegacyMember.create({ groupId: group, ...scope(lease), accountId: stored(lease.accountId), joinedAt: this.now() }, { transaction });
    }
    async _remove(group, removals, transaction) {
        await this.models.SocialLegacyMember.destroy({ where: { groupId: group, gameAccountId: { [Op.in]: removals } }, transaction });
        const remaining = await this._members([group], transaction);
        if (remaining.length > 2) { return; }
        for (const member of remaining) {
            const peer = remaining.length === 2 ? remaining.find(other => other.gameAccountId !== member.gameAccountId) : null;
            await this.models.SocialLegacyClosed.create({ groupId: group, ...scope(member), accountId: stored(member.accountId),
                peerGameAccountId: peer ? stored(peer.gameAccountId) : null, peerAccountId: peer ? stored(peer.accountId) : null,
                createdAt: this.now() }, { transaction });
        }
        await this.models.SocialLegacyMember.destroy({ where: { groupId: group }, transaction });
        await this.models.SocialLegacyGroup.destroy({ where: { id: group }, transaction });
    }
    async _end(row, groups, transaction) {
        for (const group of groups) { await this._remove(group, [stored(row.gameAccountId)], transaction); }
        await this.models.SocialLegacyClosed.destroy({ where: scope(row), transaction });
        await this.models.SocialLegacyOwner.update({ active: false, updatedAt: this.now() }, { where: scope(row), transaction });
    }

    async subscribe(context) {
        const actor = await this._actor(context, false);
        await this.runtime.selectGame(actor.owner, actor.gameId);
        const objectId = uint64(context.request.objectId);
        const row = await this._locked({ gameIds: [actor.gameId], expand: [actor.gameId] }, async ({ transaction, groups }) => {
            const current = await this._owner(actor.gameId, transaction);
            const claim = await this.models.SocialLegacyClaim.findOne({ where: { gameAccountId: actor.gameId, sessionKey: actor.owner.sessionKey }, transaction, raw: true });
            if (claim && (!current?.active || current.sessionKey !== actor.owner.sessionKey || counter(current.generation) !== counter(claim.generation))) {
                fail('LEGACY_STALE_SESSION');
            }
            if (current?.active && current.sessionKey === actor.owner.sessionKey) {
                if (!await this._live(current)) { fail('LEGACY_STALE_SESSION'); }
                await this.models.SocialLegacyOwner.update({ objectId, route: actor.owner.route, updatedAt: this.now() }, { where: scope(current), transaction });
                return { ...current, objectId, route: actor.owner.route };
            }
            if (current) { await this._end(current, groups, transaction); }
            const generation = String(BigInt(current?.generation || '0') + 1n);
            if (BigInt(generation) > 18446744073709551615n) { fail('LEGACY_CAPACITY'); }
            const value = { gameAccountId: actor.gameId, accountId: actor.owner.accountId, sessionKey: actor.owner.sessionKey,
                generation, objectId, route: actor.owner.route, active: true, updatedAt: this.now() };
            if (current) { await this.models.SocialLegacyOwner.update(value, { where: { gameAccountId: actor.gameId }, transaction }); }
            else { await this.models.SocialLegacyOwner.create(value, { transaction }); }
            await this.models.SocialLegacyClaim.create({ ...value, createdAt: this.now() }, { transaction });
            return value;
        });
        const snapshot = await this.snapshot(actor.owner, actor.gameId, counter(row.generation));
        await this.runtime.unsubscribe(actor.owner, 'legacy', actor.gameId);
        await this.runtime.subscribe(context, actor.owner, 'legacy', actor.gameId, objectId, { generation: counter(row.generation) }, snapshot);
        return snapshot;
    }

    async create(context) {
        const actor = await this._actor(context);
        const targets = [id(context.request.first?.low), id(context.request.second?.low)];
        if (new Set([actor.gameId, ...targets]).size !== 3) { fail('LEGACY_INVALID_INPUT'); }
        const receipt = await this._locked({ gameIds: [actor.gameId, ...targets] }, async ({ transaction, parents }) => {
            const self = await this._lease(actor, transaction);
            return this._receipt(actor, context, 'create', { targets }, transaction, async () => {
                const leases = [self];
                for (let i = 0; i < targets.length; ++i) {
                    const game = await this._game(targets[i], transaction);
                    if (!sameEntity(i ? context.request.second : context.request.first, entity(game))) { fail('LEGACY_INVALID_INPUT'); }
                    const lease = await this._owner(targets[i], transaction);
                    if (!await this._live(lease)) { fail('LEGACY_OFFLINE'); }
                    leases.push(lease);
                }
                await this._friends(actor.owner.accountId, leases.slice(1).map(lease => stored(lease.accountId)));
                await this._blocks(parents, transaction);
                await this._sessionBlocks(leases);
                const group = this.uuid(); groupId(group);
                await this.models.SocialLegacyGroup.create({ id: group, createdAt: this.now() }, { transaction });
                for (const lease of leases) { await this._add(group, lease, transaction); }
                return { groupId: group };
            });
        });
        return { ...await this.snapshot(actor.owner, actor.gameId, actor.generation), affectedGroupId: receipt.groupId };
    }

    async invite(context) {
        const actor = await this._actor(context);
        const group = groupId(context.request.groupId), target = id(context.request.target?.low);
        const receipt = await this._locked({ gameIds: [actor.gameId, target], groups: [group] }, async ({ transaction, members, parents }) => {
            await this._lease(actor, transaction);
            return this._receipt(actor, context, 'invite', { group, target }, transaction, async () => {
                if (!members.some(member => stored(member.gameAccountId) === actor.gameId && member.sessionKey === actor.owner.sessionKey && counter(member.generation) === actor.generation)) {
                    fail('LEGACY_GROUP_NOT_FOUND');
                }
                const game = await this._game(target, transaction);
                if (!sameEntity(context.request.target, entity(game))) { fail('LEGACY_INVALID_INPUT'); }
                const lease = await this._owner(target, transaction);
                if (!await this._live(lease)) { fail('LEGACY_OFFLINE'); }
                await this._friends(actor.owner.accountId, [stored(lease.accountId)]);
                await this._blocks(parents, transaction);
                await this._sessionBlocks([...members, lease]);
                if (members.some(member => stored(member.gameAccountId) === target)) { return { groupId: group }; }
                if (members.length >= LIMITS.members) { fail('LEGACY_CAPACITY'); }
                await this._add(group, lease, transaction);
                return { groupId: group };
            });
        });
        return { ...await this.snapshot(actor.owner, actor.gameId, actor.generation), affectedGroupId: receipt.groupId };
    }

    async leave(context) {
        const actor = await this._actor(context), group = groupId(context.request.groupId);
        await this._locked({ gameIds: [actor.gameId], groups: [group] }, async ({ transaction, members }) => {
            await this._lease(actor, transaction);
            return this._receipt(actor, context, 'leave', { group }, transaction, async () => {
                if (members.some(member => stored(member.gameAccountId) === actor.gameId && member.sessionKey === actor.owner.sessionKey && counter(member.generation) === actor.generation)) {
                    await this._remove(group, [actor.gameId], transaction);
                }
                return { groupId: group };
            });
        });
        return { ...await this.snapshot(actor.owner, actor.gameId, actor.generation), affectedGroupId: group };
    }

    async _member(member, transaction, viewerId, activity = true) {
        const game = await this._game(stored(member.gameAccountId), transaction, false);
        if (stored(game.accountId) !== stored(member.accountId)) { fail('LEGACY_NOT_OWNER'); }
        const accountId = stored(member.accountId);
        const result = { accountId: account(accountId), gameAccountId: entity(game) };
        const profile = await this.models.Account.findByPk(accountId, { attributes: ['id', 'battleTag'], transaction, raw: true });
        // BattleTag is the only name ever projected, even for a Real ID friend.
        if (profile?.battleTag) { result.battleTag = text(profile.battleTag, 1020); }
        if (!activity) { return result; }
        const denied = viewerId && viewerId !== accountId && await this.models.SocialBlock.findOne({ where: {
            [Op.or]: [{ accountId: viewerId, blockedId: accountId }, { accountId, blockedId: viewerId }]
        }, transaction, raw: true });
        if (denied) { result.online = false; return result; }
        const lease = await this._owner(stored(member.gameAccountId));
        if (member.sessionKey && (!lease || lease.sessionKey !== member.sessionKey || counter(lease.generation) !== counter(member.generation))) {
            result.online = false; return result;
        }
        result.online = !blocked(game) && Boolean(await this._live(lease));
        if (!result.online) { return result; }
        const published = await this.worldPresence.get(stored(member.gameAccountId));
        if (!published?.character || published.owner?.account_id !== accountId ||
            published.owner?.game_account_id !== stored(member.gameAccountId)) { return result; }
        const character = published.character;
        validatePresence({ sequence: published.sequence, active: true, character });
        result.activeCharacter = { guid: character.guid, name: character.name, realmAddress: character.realm_address,
            realmName: character.realm_name, level: character.level, classId: character.class, raceId: character.race,
            zoneId: character.zone, faction: character.faction };
        return result;
    }
    async snapshot(owner, gameId, generation, objectId) {
        const row = await this._owner(id(gameId));
        const game = await this._game(gameId, undefined, false);
        const snapshot = { version: 1, gameAccountId: entity(game), generation: uint64(generation), groups: [], closed: [] };
        if (owner.applicationVersion !== 15595 || owner.route?.type !== 'connection') { fail('LEGACY_UNSUPPORTED_CLIENT'); }
        if (stored(game.accountId) !== owner.accountId) { fail('LEGACY_NOT_OWNER'); }
        // Stale subscriptions see only a withdrawal, never their successor's groups.
        if (!row?.active || row.sessionKey !== owner.sessionKey || counter(row.generation) !== generation ||
            (objectId !== undefined && counter(row.objectId) !== objectId)) { return snapshot; }
        return this.models.sequelize.transaction({ isolationLevel: Transaction.ISOLATION_LEVELS.REPEATABLE_READ }, async transaction => {
            const own = await this.models.SocialLegacyMember.findAll({ where: scope(row), limit: LIMITS.groups + 1, order: [['groupId', 'ASC']], transaction, raw: true });
            if (own.length > LIMITS.groups) { fail('LEGACY_CAPACITY'); }
            for (const membership of own) {
                const members = await this._members([membership.groupId], transaction);
                const projected = [];
                for (const member of members) { projected.push(await this._member(member, transaction, owner.accountId)); }
                snapshot.groups.push({ groupId: membership.groupId, members: projected });
            }
            const closed = await this.models.SocialLegacyClosed.findAll({ where: scope(row), limit: CLOSURE_SNAPSHOT_CAPACITY + 1,
                order: [['groupId', 'ASC']], transaction, raw: true });
            if (closed.length > CLOSURE_SNAPSHOT_CAPACITY) { fail('LEGACY_CAPACITY'); }
            for (const closure of closed) {
                const value = { groupId: closure.groupId };
                if (closure.peerGameAccountId) {
                    // Closed groups no longer grant ongoing presence access.
                    value.remaining = await this._member({ gameAccountId: closure.peerGameAccountId, accountId: closure.peerAccountId }, transaction, owner.accountId, false);
                }
                snapshot.closed.push(value);
            }
            return snapshot;
        });
    }
    diff(before, after, row) {
        const prior = new Set((before?.closed || []).map(closure => closure.groupId));
        const frames = after.closed.filter(closure => !prior.has(closure.groupId)).map(closure => frame('OnClosed', counter(row.objectId), closure));
        // The native group slot must still exist when it consumes conversion;
        // the replacement snapshot follows all closure callbacks.
        frames.push(frame('OnSnapshot', counter(row.objectId), after));
        return frames;
    }

    async _routes(lease) {
        const routes = await this.runtime.recipients(stored(lease.accountId), 'legacy');
        return routes.filter(row => row.sessionKey === lease.sessionKey && row.target === stored(lease.gameAccountId) &&
            counter(row.objectId) === counter(lease.objectId) && counter(json(row.filter).generation) === counter(lease.generation));
    }
    async send(context) {
        const actor = await this._actor(context), group = groupId(context.request.groupId);
        const message = text(context.request.text, LIMITS.messageBytes);
        if (!message.trim() || !message.isWellFormed()) { fail('LEGACY_INVALID_INPUT'); }
        return this._locked({ gameIds: [actor.gameId], groups: [group] }, async ({ transaction, members, parents }) => {
            await this._lease(actor, transaction);
            if (!members.some(member => stored(member.gameAccountId) === actor.gameId && member.sessionKey === actor.owner.sessionKey && counter(member.generation) === actor.generation)) {
                fail('LEGACY_GROUP_NOT_FOUND');
            }
            await this._blocks(parents, transaction);
            const routes = [];
            for (const member of members) {
                const lease = await this._owner(stored(member.gameAccountId), transaction);
                if (!lease || lease.sessionKey !== member.sessionKey || counter(lease.generation) !== counter(member.generation) || !await this._live(lease)) {
                    fail('LEGACY_OFFLINE');
                }
                const delivery = await this._routes(lease);
                if (delivery.length !== 1) { fail('LEGACY_OFFLINE'); }
                routes.push(delivery[0]);
            }
            await this._sessionBlocks(members);
            const operationId = this.runtime.operationId(context);
            if (!/^[0-9a-f]{64}$/.test(operationId)) { throw new Error('Invalid runtime operation ID'); }
            const requestHash = digest({ group, gameId: actor.gameId, generation: actor.generation, sessionKey: actor.owner.sessionKey, message });
            const key = '/skymist/v1/social/legacy/send/' + actor.owner.accountId + '/' + operationId;
            const claim = { hash: requestHash, state: 'uncertain' };
            const accepted = await this.runtime.store.run(client => client.set(key, JSON.stringify(claim), { NX: true, EX: LIMITS.dedupSeconds }));
            if (!accepted) {
                const previous = json(await this.runtime.store.run(client => client.get(key)));
                if (!previous || previous.hash !== requestHash) { fail('LEGACY_OPERATION_CONFLICT'); }
                if (previous.state === 'sent') { return {}; }
                fail('LEGACY_SEND_UNCONFIRMED');
            }
            const sender = await this._member({ accountId: actor.owner.accountId, gameAccountId: actor.gameId }, transaction);
            try {
                for (const route of routes) {
                    if (!await this.runtime.notify(route, [frame('OnMessage', counter(route.objectId), {
                        groupId: group, sender, text: message, messageId: operationId
                    })])) { fail('LEGACY_SEND_UNCONFIRMED'); }
                }
                const marked = await this.runtime.store.run(client => client.set(key, JSON.stringify({ ...claim, state: 'sent' }), { XX: true, EX: LIMITS.dedupSeconds }));
                if (!marked) { fail('LEGACY_SEND_UNCONFIRMED'); }
            } catch { fail('LEGACY_SEND_UNCONFIRMED'); }
            return {};
        });
    }

    // Call from the social worker's pulse, never from gameplay readiness gates.
    // A dependency exception leaves state untouched; absence of a verified live
    // principal ends membership. A later retry rechecks the current generation.
    async cleanup(limit = 20) {
        if (!Number.isInteger(limit) || limit < 1 || limit > 100) { fail('LEGACY_INVALID_INPUT'); }
        const rows = await this.models.SocialLegacyOwner.findAll({ where: { gameAccountId: { [Op.gt]: this.cursor } },
            order: [['gameAccountId', 'ASC']], limit, raw: true });
        for (const row of rows) {
            const game = await this._game(stored(row.gameAccountId), undefined, false);
            if (row.active && (blocked(game) || !await this._live(row))) {
                await this._locked({ gameIds: [stored(row.gameAccountId)], expand: [stored(row.gameAccountId)] }, async ({ transaction, groups }) => {
                    const current = await this._owner(stored(row.gameAccountId), transaction);
                    const currentGame = await this._game(stored(row.gameAccountId), transaction, false);
                    if (current?.active && current.sessionKey === row.sessionKey && counter(current.generation) === counter(row.generation) &&
                        (blocked(currentGame) || !await this._live(current))) {
                        await this._end(current, groups, transaction);
                    }
                });
            } else if (row.active) {
                // Runtime persists its snapshot only after confirming delivery.
                // Prune acknowledged closure metadata; never persist or replay text.
                for (const subscription of await this._routes(row)) {
                    const closed = json(subscription.snapshot)?.closed || [];
                    if (closed.length) {
                        await this.models.SocialLegacyClosed.destroy({ where: { ...scope(row), groupId: { [Op.in]: closed.map(value => value.groupId) } } });
                    }
                }
            }
        }
        this.cursor = rows.length === limit ? stored(rows.at(-1).gameAccountId) : '0';
    }
}

module.exports = { LegacyChat, LegacyChatError, STATUS, LIMITS, CLOSURE_SNAPSHOT_CAPACITY, FILE, NAMESPACE, entity, frame };
