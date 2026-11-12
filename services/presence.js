'use strict';

const { jsonColumn: json } = require('../utils/json-column');
const Service = require('./service');
const wire = require('../social/wire');
const presence = require('../social/presence-wire');
const { ownerFor, gameEntity, storedId, status } = require('../social/friends-wire');
const { blocked } = require('../utils/admin-state');
const entity = value => ({ high: value.high.toString(), low: value.low.toString() });
const microseconds = () => (BigInt(Date.now()) * 1000n).toString();

class PresenceService extends Service {
    constructor(dependencies) {
        super('PresenceService', 'proto/bgs/low/pb/client/presence_service.proto', dependencies);
        this.runtime = dependencies.runtime; this.models = dependencies.models; this.worldPresence = dependencies.worldPresence;
        this.runtime.presence = this;
        this.runtime.register('presence', { snapshot: (owner, row) => this.project(owner, row), diff: presence.diff });
        // Ownership rows bind the selected license to the authenticated connection. They produce no events.
        this.runtime.register('presence-owner', { snapshot: async () => ({}), diff: () => [] });
        for (const name of ['Subscribe', 'Unsubscribe', 'Query', 'Update', 'Ownership', 'SubscribeNotification']) {
            this.registerHandler(name, async context => {
                try { return await this[name](context); } catch (error) { throw status(error); }
            });
        }
    }
    async resolve(value) {
        if (value?.high?.toString() === wire.ACCOUNT_HIGH) {
            const id = wire.accountId(value);
            return { subject: 'a:' + id, accountId: id, entity: entity(value) };
        }
        const game = await gameEntity(this.models, value);
        return { subject: 'g:' + storedId(game.id), accountId: storedId(game.accountId), game, entity: entity(game.entityId) };
    }
    async access(owner, target) {
        if (owner.accountId !== target.accountId) {
            if (await this.runtime.sessionBlocked(owner.sessionKey, target.accountId)) { throw 0x1391; }
            await this.runtime.graph.assertAccess(owner.accountId, target.accountId, 'presence');
        }
    }
    filter(request) {
        if ((request.key?.length || 0) > 128 || (request.program?.length || 0) > 16) { throw 0x7; }
        return { program: request.program || [], keys: (request.key || []).map(key => ({ program: key.program,
            group: key.group, field: key.field, uniqueId: wire.uint64(key.uniqueId) })) };
    }
    async state(target, online, changes) {
        return this.models.sequelize.transaction(async transaction => {
            await this.models.Account.findByPk(target.accountId, { transaction, lock: transaction.LOCK.UPDATE });
            const row = await this.models.SocialPresenceState.findByPk(target.subject, { transaction });
            const previous = row ? json(row.values) : {};
            const values = { ...previous };
            if (online !== undefined && values.online !== online) {
                values.online = online;
                if (online) { values.onlineTime = microseconds(); }
                else { values.lastOnline = microseconds(); }
            }
            Object.assign(values, changes);
            if (!row) { await this.models.SocialPresenceState.create({ subject: target.subject, accountId: target.accountId, values }, { transaction }); }
            else if (JSON.stringify(previous) !== JSON.stringify(values)) { await row.update({ values }, { transaction }); }
            return values;
        });
    }
    async owned(context, owner, target) {
        if (target.accountId !== owner.accountId || owner.gameAccountId && target.game && storedId(target.game.id) !== owner.gameAccountId) { throw 0xA; }
        if (target.game && blocked(target.game)) { throw 0xA; }
        if (target.game) {
            await this.runtime.selectGame(owner, storedId(target.game.id));
            await this.runtime.subscribe(context, { ...owner, gameAccountId: storedId(target.game.id) },
                'presence-owner', target.subject, '0', {}, {});
        }
    }
    async gameOnline(game) {
        if (blocked(game)) { return { online: false, character: null }; }
        const gameId = storedId(game.id);
        const world = await this.worldPresence.session(gameId);
        const record = world ? await this.worldPresence.get(gameId) : null;
        if (world) { return { online: true, character: record?.character || null }; }
        const rows = await this.models.SocialSubscription.findAll({ where: { target: 'g:' + gameId, kind: 'presence-owner', ready: true }, limit: 65, raw: true });
        if (rows.length > 64) { throw 0x25; }
        for (const row of rows) {
            if (await this.runtime.current(json(row.route), storedId(game.accountId))) { return { online: true, character: null }; }
        }
        return { online: false, character: null };
    }
    async fields(owner, target) {
        const f = (number, value, uniqueId) => presence.field(presence.BN, target.game ? 2 : 1, number, value, uniqueId);
        if (!target.game) {
            const profile = await this.models.Account.findByPk(target.accountId);
            if (blocked(profile)) { return []; }
            const projection = owner.accountId === target.accountId ? { realIdVisible: profile.realIdEnabled,
                givenName: profile.givenName, surname: profile.surname } : await this.runtime.graph.project(owner.accountId, target.accountId);
            if (!projection) { return []; }
            const games = await this.models.GameAccount.findAll({ where: { accountId: target.accountId }, order: [['id', 'ASC']], limit: 257 });
            if (games.length > 256) { throw 0x25; }
            const onlineGames = [];
            for (const game of games) { if ((await this.gameOnline(game)).online) { onlineGames.push(game); } }
            const online = onlineGames.length > 0 || (await this.runtime.recipients(target.accountId, 'friends')).length > 0;
            const values = await this.state(target, online);
            const fields = [f(1, { stringValue: projection.realIdVisible ? [projection.givenName, projection.surname].filter(Boolean).join(' ') : '' }),
                f(2, { stringValue: values.broadcast || '' }), f(4, { stringValue: profile.battleTag }),
                f(5, { intValue: values.broadcastTime || '0' }), f(6, { intValue: values.lastOnline || '0' }),
                f(7, { boolValue: online && Boolean(values.afk) }), f(11, { boolValue: online && Boolean(values.dnd) })];
            for (const game of onlineGames) { fields.push(f(3, { entityIdValue: entity(game.entityId) }, storedId(game.id))); }
            return fields;
        }
        const live = await this.gameOnline(target.game);
        const values = await this.state(target, live.online);
        const parent = await this.state({ subject: 'a:' + target.accountId, accountId: target.accountId });
        const fields = [f(1, { boolValue: live.online }), f(2, { intValue: live.online && (values.dnd ?? parent.dnd) ? '1' : '0' }),
            f(7, { entityIdValue: entity(wire.account(target.accountId)) }),
            f(10, { boolValue: live.online && Boolean(values.afk ?? parent.afk) })];
        if (live.character) { fields.push(...this.characterFields(live.character)); }
        return fields;
    }
    characterFields(character) {
        const field = (number, value) => presence.field(presence.WOW, 2, number, value);
        // 26972 reads these individually (0x140D358E0) and resolves names in its
        // own realm/DB2 caches (0x140A57CE0). The GUID field is explicitly uint64;
        // the client reconstructs the player GUID using the realm ID separately.
        return [field(1, { uintValue: String(character.realm_address) }),
            field(2, { uintValue: String(character.race) }), field(3, { uintValue: String(character.class) }),
            field(5, { uintValue: String(character.level) }), field(6, { uintValue: String(character.zone) }),
            field(7, { intValue: ['2', '4', '1'][character.faction] }),
            field(10, { stringValue: character.name }), field(11, { uintValue: String(character.realm_address & 0xffff) }),
            field(12, { uintValue: (BigInt(character.guid) & 0xffffffffffffffffn).toString() })];
    }
    async project(owner, row) {
        const target = await this.resolve(json(row.filter).entity);
        let fields;
        try { await this.access(owner, target); fields = await this.fields(owner, target); }
        catch (error) {
            if (error !== 0x1391 && error.code !== 'BLOCKED' && error.code !== 'NOT_FRIENDS' && error.code !== 'ACCOUNT_NOT_FOUND') { throw error; }
            fields = []; // Withdraw every previously visible field when access is revoked.
        }
        return { entity: target.entity, fields: presence.selected(fields, json(row.filter)) };
    }
    async Subscribe(context) {
        const owner = await ownerFor(this.runtime, this.models, context);
        const target = await this.resolve(context.request.entityId);
        await this.access(owner, target);
        const objectId = wire.uint64(context.request.objectId);
        if (owner.accountId === target.accountId && target.game) { await this.owned(context, owner, target); }
        await this.runtime.subscribe(context, owner, 'presence', target.subject, objectId, { ...this.filter(context.request), entity: target.entity });
        return 0;
    }
    async Unsubscribe(context) {
        const owner = await ownerFor(this.runtime, this.models, context);
        const target = await this.resolve(context.request.entityId);
        await this.runtime.unsubscribe(owner, 'presence', target.subject,
            Object.hasOwn(context.request, 'objectId') ? wire.uint64(context.request.objectId) : undefined);
        return 0;
    }
    async Query(context) {
        const owner = await ownerFor(this.runtime, this.models, context);
        const target = await this.resolve(context.request.entityId);
        await this.access(owner, target);
        context.response.field = presence.selected(await this.fields(owner, target), this.filter(context.request));
        return 0;
    }
    async Update(context) {
        const owner = await ownerFor(this.runtime, this.models, context);
        const target = await this.resolve(context.request.entityId);
        if (target.accountId !== owner.accountId) { throw 0xA; }
        const operations = context.request.fieldOperation || [];
        if (!operations.length || operations.length > 16) { throw 0x7; }
        const changes = {};
        for (const operation of operations) {
            const { key, value } = operation.field;
            if (key.program !== presence.BN || key.group !== (target.game ? 2 : 1) || wire.uint64(key.uniqueId) !== '0' ||
                operation.operation !== 0 && operation.operation !== 1) { throw 0xBC1; }
            const clear = operation.operation === 1;
            if (!target.game && key.field === 2) {
                if (!clear && (Object.keys(value).length !== 1 || !Object.hasOwn(value, 'stringValue'))) { throw 0x7; }
                const message = clear ? '' : wire.text(value.stringValue, 508);
                if (!message.isWellFormed() || [...message].length > 127) { throw 0x7; }
                changes.broadcast = message; changes.broadcastTime = microseconds();
            } else if ((!target.game && [7, 11].includes(key.field)) || (target.game && key.field === 10)) {
                if (!clear && (Object.keys(value).length !== 1 || !Object.hasOwn(value, 'boolValue'))) { throw 0x7; }
                const name = key.field === 11 ? 'dnd' : 'afk';
                changes[name] = !clear && value.boolValue;
                if (changes[name]) { changes[name === 'afk' ? 'dnd' : 'afk'] = false; }
            } else if (target.game && key.field === 2) {
                if (!clear && (Object.keys(value).length !== 1 || !Object.hasOwn(value, 'intValue') || !['0', '1'].includes(value.intValue.toString()))) { throw 0x7; }
                changes.dnd = !clear && value.intValue.toString() === '1';
                if (changes.dnd) { changes.afk = false; }
            } else { throw 0xBC1; } // Identity, online state and active character are server-owned.
        }
        await this.owned(context, owner, target);
        await this.state(target, undefined, changes);
        return 0;
    }
    async Ownership(context) {
        const owner = await ownerFor(this.runtime, this.models, context);
        const target = await this.resolve(context.request.entityId);
        if (target.accountId !== owner.accountId) { throw 0xA; }
        if (context.request.releaseOwnership) { await this.runtime.unsubscribe(owner, 'presence-owner', target.subject); }
        else { await this.owned(context, owner, target); }
        return 0;
    }
    async SubscribeNotification(context) {
        const owner = await ownerFor(this.runtime, this.models, context);
        await this.access(owner, await this.resolve(context.request.entityId));
        return 0;
    }
}
module.exports = PresenceService;
