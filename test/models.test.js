'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const createDatabase = require('../models');
const loadProto = require('../utils/protobuf');
const EntityId = loadProto('proto/bgs/low/pb/client/entity_types.proto').lookupType('bgs.protocol.EntityId');
const config = { dialect: 'mysql', database: 'bgs', username: 'test', password: 'test' };
const logger = { debug() {} };

test('model factories preserve tables, columns and both associations without connecting', async () => {
    const db = createDatabase(config, logger);
    try {
        assert.equal(db.Account.getTableName(), 'accounts');
        assert.equal(db.GameAccount.getTableName(), 'game_accounts');
        assert.equal(db.Account.associations.gameAccounts.target, db.GameAccount);
        assert.equal(db.GameAccount.associations.Account.target, db.Account);
        assert.equal(db.Account.associations.gameAccounts.foreignKey, 'accountId');
        assert.equal(db.GameAccount.associations.Account.foreignKey, 'accountId');
        assert.equal(db.GameAccount.rawAttributes.accountId.field, 'account_id');
        assert.equal(db.GameAccount.rawAttributes.account_id, undefined);
        assert.equal(db.Account.rawAttributes.battleTag.field, 'battle_tag');
        assert.equal(db.Account.rawAttributes.isBanned.field, 'banned');
        assert.equal(db.GameAccount.rawAttributes.tutorialData.field, 'tutorial_data');
        assert.equal(db.GameAccount.rawAttributes.createdAt.field, 'created_at');
        const account = db.Account.build({ id: '9007199254740993', gameAccounts: [
            { id: '9007199254740995', accountId: '9007199254740993', program: 'WoW', region: 2 }
        ] }, { include: [{ model: db.GameAccount, as: 'gameAccounts' }] });
        assert.equal(account.gameAccounts[0].accountId, account.id);
    }
    finally {
        await db.sequelize.close();
    }
});

test('entity getters preserve unsigned 64-bit identifiers and fixed wire fixtures', async () => {
    const db = createDatabase(config, logger);
    try {
        for (const id of ['9007199254740993', '18446744073709551615', 1]) {
            for (const model of [db.Account, db.GameAccount]) {
                const entity = model.build({ id, program: 'WoW', region: 2 }).entityId;
                const decoded = EntityId.decode(EntityId.encode(entity).finish());
                assert.equal(decoded.low.toString(), String(id));
                assert.equal(decoded.low.unsigned, true);
            }
        }
        const account = db.Account.build({ id: '9007199254740993' });
        const game = db.GameAccount.build({ id: '9007199254740993', program: 'WoW', region: 2 });
        assert.equal(EntityId.encode(account.entityId).finish().toString('hex'), '090000000000000001110100000000002000');
        assert.equal(EntityId.encode(game.entityId).finish().toString('hex'), '09576f570002000002110100000000002000');
    }
    finally {
        await db.sequelize.close();
    }
});

test('database URL setting accepts both spellings and prefers the conventional key', async () => {
    const environment = { NEW_URL: 'mysql://user:pass@localhost:3306/new_db', OLD_URL: 'mysql://user:pass@localhost:3306/old_db' };
    for (const [options, expected] of [
        [{ use_env_variable: 'NEW_URL' }, 'new_db'],
        [{ use_env_letiable: 'OLD_URL' }, 'old_db'],
        [{ use_env_variable: 'NEW_URL', use_env_letiable: 'OLD_URL' }, 'new_db']
    ]) {
        const db = createDatabase(options, logger, environment);
        assert.equal(db.sequelize.config.database, expected);
        await db.sequelize.close();
    }
});

test('existing foreign-key migration uses the Sequelize 6 API without changing the constraint', async () => {
    const calls = [];
    const migration = require('../migrations/20180807151827-add-account-id');
    await migration.up({
        addColumn: async (...args) => calls.push(args),
        addConstraint: async (...args) => calls.push(args)
    }, require('sequelize'));
    assert.equal(calls[0][1], 'account_id');
    assert.deepEqual(calls[1], ['game_accounts', {
        fields: ['account_id'], type: 'foreign key', name: 'account_key',
        references: { table: 'accounts', field: 'id' }, onDelete: 'cascade', onUpdate: 'cascade'
    }]);
});


test('forced database cleanup destroys active connections and rejects late native acquisitions', async () => {
    const db = createDatabase(config, logger);
    let destroyed = 0;
    const connection = { destroy: () => { destroyed++; } };
    await db.sequelize.runHooks('afterConnect', connection);
    await db.forceClose();
    assert.equal(destroyed, 1);
    await assert.rejects(db.sequelize.runHooks('afterConnect', { destroy: () => { destroyed++; } }), /after forced shutdown/);
    assert.equal(destroyed, 2);
    await db.sequelize.close();
});
