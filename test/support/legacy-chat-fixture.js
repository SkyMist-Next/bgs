'use strict';

const assert = require('node:assert/strict');
const { createHash, randomUUID } = require('node:crypto');
const { Sequelize, DataTypes: T, Op, Transaction } = require('sequelize');
const define = require('../../models/sociallegacy');
const defineSubscriptions = require('../../models/socialruntime');
const { LegacyChat, entity } = require('../../social/legacy-chat');

// Controlled persistence/Redis/transport substitutes. These tests exercise the
// actual protobufs, models, policy and receipt logic, not InnoDB or live AMQP.
function fixture() {
    const sequelize = new Sequelize('unused', 'unused', '', { dialect: 'mysql', logging: false });
    const models = {
        sequelize,
        Account: sequelize.define('Account', { id: { type: T.BIGINT, primaryKey: true }, battleTag: T.STRING,
            givenName: T.STRING, surname: T.STRING, realIdEnabled: T.BOOLEAN }, { timestamps: false }),
        GameAccount: sequelize.define('GameAccount', { id: { type: T.BIGINT, primaryKey: true }, accountId: T.BIGINT,
            program: T.STRING, region: T.INTEGER, expansion: T.INTEGER, isBanned: T.BOOLEAN }, { timestamps: false }),
        SocialBlock: sequelize.define('SocialBlock', { accountId: { type: T.BIGINT, primaryKey: true },
            blockedId: { type: T.BIGINT, primaryKey: true } }, { timestamps: false }),
        ...define(sequelize, T), ...defineSubscriptions(sequelize, T)
    };
    const modelEntries = Object.entries(models).filter(([name]) => name !== 'sequelize');
    let tables = new Map(modelEntries.map(([name]) => [name, new Map()]));
    let tail = Promise.resolve(), nextToken = 0, now = 1000000;
    let activeTransaction = null;
    const locks = [], policyReads = [], sessions = new Map(), friendships = new Set(), redis = new Map(), frames = [], characters = new Map();
    const sessionBlocks = new Set();
    const key = (model, row) => JSON.stringify(model.primaryKeyAttributes.map(field => row[field]));
    const data = (name, transaction) => (transaction?.tables || tables).get(name);
    const comparable = value => typeof value === 'string' && /^\d+$/.test(value) ? BigInt(value) : value;
    function matches(row, where = {}) {
        return Reflect.ownKeys(where).every(field => {
            const expected = where[field];
            if (field === Op.or) { return expected.some(value => matches(row, value)); }
            if (expected && typeof expected === 'object' && !(expected instanceof Date)) {
                return Reflect.ownKeys(expected).every(op => {
                    if (op === Op.in) { return expected[op].includes(row[field]); }
                    if (op === Op.gt) { return comparable(row[field]) > comparable(expected[op]); }
                    if (op === Op.lt) { return comparable(row[field]) < comparable(expected[op]); }
                    if (op === Op.ne) { return row[field] !== expected[op]; }
                    throw new Error('Unsupported fixture predicate');
                });
            }
            return row[field] === expected;
        });
    }
    function instance(model, row, transaction) {
        return { ...structuredClone(row), get: () => structuredClone(row), update: async changes => {
            const result = { ...row, ...changes }; data(model.name, transaction).set(key(model, row), result);
            return instance(model, result, transaction);
        } };
    }
    for (const [name, model] of modelEntries) {
        model.findAll = async (query = {}) => {
            let rows = [...data(name, query.transaction).values()].filter(row => matches(row, query.where));
            if (query.order) {
                rows.sort((a, b) => {
                    for (const [field, direction] of query.order) {
                        const left = comparable(a[field]), right = comparable(b[field]);
                        if (left !== right) { return (left < right ? -1 : 1) * (direction === 'DESC' ? -1 : 1); }
                    }
                    return 0;
                });
            }
            if (query.limit !== undefined) { rows = rows.slice(0, query.limit); }
            if (name === 'SocialBlock' && query.where?.accountId?.[Op.in]) {
                for (const accountId of query.where.accountId[Op.in]) { assert.ok(query.transaction?.locked.has(accountId), 'block reads follow parent locks'); }
                policyReads.push('blocks');
            }
            return rows.map(row => query.raw ? structuredClone(row) : instance(model, row, query.transaction));
        };
        model.findOne = async query => (await model.findAll({ ...query, limit: 1 }))[0] || null;
        model.findByPk = async (id, query = {}) => {
            if (name === 'Account' && query.lock) {
                query.transaction.locked.add(id); locks.push({ transaction: query.transaction.serial, id });
            }
            return model.findOne({ ...query, where: { [model.primaryKeyAttributes[0]]: id } });
        };
        model.count = async query => (await model.findAll({ ...query, raw: true })).length;
        model.create = async (values, query = {}) => {
            const row = model.build(values);
            await row.validate();
            const value = row.get({ plain: true });
            const table = data(name, query.transaction), pk = key(model, value);
            assert.equal(table.has(pk), false, 'duplicate fixture primary key');
            table.set(pk, structuredClone(value));
            return instance(model, value, query.transaction);
        };
        model.update = async (values, query) => {
            const rows = await model.findAll({ ...query, raw: true });
            for (const row of rows) { data(name, query.transaction).set(key(model, row), { ...row, ...structuredClone(values) }); }
            return [rows.length];
        };
        model.destroy = async query => {
            const rows = await model.findAll({ ...query, raw: true });
            for (const row of rows) { data(name, query.transaction).delete(key(model, row)); }
            return rows.length;
        };
    }
    let transactionSerial = 0;
    sequelize.transaction = async (options, work) => {
        let done;
        const before = tail;
        tail = new Promise(resolve => { done = resolve; });
        await before;
        const transaction = { serial: ++transactionSerial, LOCK: Transaction.LOCK, tables: structuredClone(tables), locked: new Set() };
        activeTransaction = transaction;
        try { const result = await work(transaction); tables = transaction.tables; return result; }
        finally { activeTransaction = null; done(); }
    };
    const runtime = {
        models, projectors: new Map(), frames, currentFailure: false, notificationFailure: false,
        worldPresence: { async get(gameId) { return characters.get(gameId) || null; } },
        register(kind, projector) { this.projectors.set(kind, projector); },
        async owner(context) { return context.owner; },
        operationId(context) { return createHash('sha256').update(context.owner.sessionKey + ':' + context.header.token).digest('hex'); },
        async current(route, accountId) {
            if (this.currentFailure) { throw new Error('Redis temporarily unavailable'); }
            const owner = sessions.get(route.connectionId);
            return owner?.accountId === accountId ? owner : null;
        },
        async unsubscribe(owner, kind, target) { await models.SocialSubscription.destroy({ where: { sessionKey: owner.sessionKey, kind, target } }); },
        async selectGame(owner, gameId) {
            const actual = sessions.get(owner.route.connectionId);
            if (!actual || actual.gameAccountId && actual.gameAccountId !== gameId) { throw 0xA; }
            actual.gameAccountId = gameId; owner.gameAccountId = gameId;
            return owner;
        },
        async sessionBlocked(sessionKey, otherAccountId) { return sessionBlocks.has(sessionKey + ':' + otherAccountId); },
        async subscribe(context, owner, kind, target, objectId, filter, snapshot) {
            return models.SocialSubscription.create({ id: randomUUID(), accountId: owner.accountId, gameAccountId: owner.gameAccountId,
                sessionKey: owner.sessionKey, kind, target, objectId, filter, snapshot, route: owner.route, ready: true, expiresAt: new Date(now + 300000) });
        },
        async recipients(accountId, kind) { return models.SocialSubscription.findAll({ where: { accountId, kind, ready: true }, raw: true }); },
        async notify(row, values) {
            if (this.notificationFailure) { throw new Error('Publication confirmation lost'); }
            for (const value of values) { frames.push({ row, ...value }); }
            return true;
        },
        graph: {
            async assertAccess(a, b) {
                assert.ok(activeTransaction?.locked.has(a) && activeTransaction.locked.has(b), 'friend policy follows canonical parent locks');
                policyReads.push('friends');
                if (!friendships.has([a, b].sort().join(':'))) { const error = new Error('NOT_FRIENDS'); error.code = 'NOT_FRIENDS'; throw error; }
            }
        },
        store: { async run(work) {
            return work({
                async get(key) { const value = redis.get(key); return value && value.until > now ? value.value : null; },
                async set(key, value, options) {
                    const existing = redis.get(key), present = existing && existing.until > now;
                    if (options.NX && present || options.XX && !present) { return null; }
                    redis.set(key, { value, until: now + options.EX * 1000 }); return 'OK';
                }
            });
        } }
    };
    const chat = new LegacyChat(runtime, { now: () => new Date(now) });
    return {
        models, sequelize, runtime, chat, locks, policyReads, sessions, sessionBlocks, redis, frames, characters,
        tables: () => tables,
        tick(milliseconds) { now += milliseconds; },
        friend(a, b) { friendships.add([a, b].sort().join(':')); },
        async game(gameId, accountId, connection = 'connection-' + gameId) {
            if (!await models.Account.findByPk(accountId)) { await models.Account.create({ id: accountId, battleTag: 'Player#' + accountId,
                givenName: 'Private', surname: 'Person', realIdEnabled: true }); }
            const game = { id: gameId, accountId, program: 'WoW', region: 3, expansion: 3, isBanned: false };
            if (!await models.GameAccount.findByPk(gameId)) { await models.GameAccount.create(game); }
            const route = { type: 'connection', connectionId: connection, address: '127.0.0.1', queueName: 'q-' + connection };
            const owner = { accountId, applicationVersion: 15595, connectionId: connection, sessionKey: 'c:' + connection, route };
            sessions.set(connection, owner);
            return { gameId, accountId, game, owner };
        },
        context(actor, request = {}, token) {
            return { owner: actor.owner, header: { token: token ?? ++nextToken }, request: {
                version: 1, gameAccountId: entity(actor.game), generation: actor.generation || '1', ...request
            } };
        },
        async subscribe(actor, objectId = '1') {
            const result = await chat.subscribe(this.context(actor, { objectId }));
            actor.generation = result.generation; return result;
        }
    };
}
module.exports = { fixture };
