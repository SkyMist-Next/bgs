'use strict';

const { Sequelize, Op, Transaction, DataTypes } = require('sequelize');
const define = require('../../models/socialgraph');
const { SocialGraph } = require('../../social/graph');

// Real Sequelize model instances with an in-memory persistence substitute. The SQL suite separately
// validates actual InnoDB locks, constraints, isolation and rollback. No live credentials are needed here.
function fixture(options = {}) {
    const sequelize = new Sequelize('unused', 'unused', '', { dialect: 'mysql', logging: false });
    const Account = sequelize.define('Account', {
        id: { type: DataTypes.BIGINT, primaryKey: true }, battleTag: DataTypes.STRING,
        givenName: DataTypes.STRING, surname: DataTypes.STRING, realIdEnabled: DataTypes.BOOLEAN
    }, { timestamps: false });
    const models = { ...define(sequelize, DataTypes), SocialSessionBlock: require('../../models/socialsessionblock')(sequelize, DataTypes) };
    const all = { Account, ...models };
    const tables = new Map(Object.keys(all).map(name => [name, new Map()]));
    const lockOwners = new Map();
    const lockTrace = [];
    const queries = [];
    let serial = 9007199254740993n;
    let transactionId = 0;
    let failOutbox = false;
    const keys = (model, row) => model.primaryKeyAttributes.map(key => row[key]).join(':');
    function matches(row, where = {}) {
        return Reflect.ownKeys(where).every(key => {
            const value = where[key];
            if (key === Op.or) { return value.some(condition => matches(row, condition)); }
            if (value && typeof value === 'object' && !(value instanceof Date)) {
                if (Op.in in value) { return value[Op.in].includes(row[key]); }
                if (Op.gte in value) { return row[key] >= value[Op.gte]; }
                throw new Error('Unsupported fixture predicate');
            }
            return row[key] === value;
        });
    }
    function rows(name, transaction) {
        const base = transaction?.snapshot || tables;
        const result = new Map(base.get(name));
        for (const [key, value] of transaction?.writes.get(name) || []) {
            if (value === null) { result.delete(key); }
            else { result.set(key, value); }
        }
        return result;
    }
    function write(name, key, value, transaction) {
        if (transaction) { transaction.writes.get(name).set(key, value); }
        else if (value === null) { tables.get(name).delete(key); }
        else { tables.get(name).set(key, value); }
    }
    function instance(model, row, transaction) {
        const value = model.build(structuredClone(row), { isNewRecord: false });
        value.update = async changes => {
            Object.assign(value, changes);
            write(model.name, keys(model, row), { ...row, ...changes }, transaction);
            return value;
        };
        return value;
    }
    for (const [name, model] of Object.entries(all)) {
        model.findAll = async (query = {}) => {
            queries.push({ name, query });
            let result = [...rows(name, query.transaction).values()].filter(row => matches(row, query.where));
            if (query.group) { result = [...new Map(result.map(row => [JSON.stringify(query.group.map(key => row[key])), row])).values()]; }
            if (query.order) {
                result.sort((a, b) => {
                    for (const [key] of query.order) {
                        const left = /^[0-9]+$/.test(String(a[key])) ? BigInt(a[key]) : a[key];
                        const right = /^[0-9]+$/.test(String(b[key])) ? BigInt(b[key]) : b[key];
                        if (left !== right) { return left < right ? -1 : 1; }
                    }
                    return 0;
                });
            }
            if (query.limit !== undefined) { result = result.slice(0, query.limit); }
            return result.map(row => query.raw ? structuredClone(row) : instance(model, row, query.transaction));
        };
        model.findOne = async query => (await model.findAll({ ...query, limit: 1 }))[0] || null;
        model.findByPk = async (id, query = {}) => {
            if (query.lock) {
                const transaction = query.transaction;
                while (lockOwners.has(id) && lockOwners.get(id) !== transaction) {
                    await lockOwners.get(id).done;
                }
                lockOwners.set(id, transaction);
                lockTrace.push({ transactionId: transaction.id, id });
            }
            return model.findOne({ ...query, where: { id } });
        };
        model.count = async query => [...rows(name, query.transaction).values()].filter(row => matches(row, query.where)).length;
        model.create = async (values, query = {}) => {
            if (failOutbox && name === 'SocialOutbox') { throw new Error('Injected outbox failure'); }
            const row = model.build(values);
            if (model.autoIncrementAttribute && !row[model.autoIncrementAttribute]) { row[model.autoIncrementAttribute] = String(serial++); }
            await row.validate();
            const data = row.get({ plain: true });
            const key = keys(model, data);
            if (rows(name, query.transaction).has(key)) { throw new Error('Duplicate primary key'); }
            write(name, key, data, query.transaction);
            return instance(model, data, query.transaction);
        };
        model.update = async (values, query) => {
            const result = [...rows(name, query.transaction).values()].filter(row => matches(row, query.where));
            for (const row of result) { write(name, keys(model, row), { ...row, ...values }, query.transaction); }
            return [result.length];
        };
        model.destroy = async query => {
            const result = [...rows(name, query.transaction).values()].filter(row => matches(row, query.where));
            for (const row of result) { write(name, keys(model, row), null, query.transaction); }
            return result.length;
        };
    }
    sequelize.transaction = async (settings, work) => {
        if (typeof settings === 'function') { work = settings; settings = {}; }
        let release;
        const transaction = {
            id: ++transactionId, LOCK: Transaction.LOCK,
            writes: new Map(Object.keys(all).map(name => [name, new Map()])),
            snapshot: settings.isolationLevel === Transaction.ISOLATION_LEVELS.REPEATABLE_READ ? structuredClone(tables) : null,
            done: new Promise(resolve => { release = resolve; })
        };
        try {
            const result = await work(transaction);
            for (const [name, changes] of transaction.writes) {
                for (const [key, value] of changes) { write(name, key, value); }
            }
            return result;
        }
        finally {
            for (const [id, owner] of lockOwners) { if (owner === transaction) { lockOwners.delete(id); } }
            release();
        }
    };
    const graph = new SocialGraph({ sequelize, Account, models, ...options });
    return {
        graph, sequelize, models, Account, tables, lockTrace, queries,
        failOutbox: value => { failOutbox = value; },
        account: (id, extras = {}) => Account.create({ id, battleTag: `Player#${id}`, givenName: 'Private', surname: 'Person', realIdEnabled: false, ...extras })
    };
}

module.exports = { fixture };
