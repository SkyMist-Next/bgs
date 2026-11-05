'use strict';
module.exports = function defineRealmGameplay(sequelize, DataTypes) {
    const schema = require('../utils/realm-schema-v1')(sequelize, DataTypes);
    return { ...Object.fromEntries(Object.entries(schema).map(([key, { name, tableName, attributes }]) =>
        [key, sequelize.define(name, attributes, { tableName, timestamps: false, engine: 'InnoDB' })])),
        AccountRestoration: sequelize.define('AccountRestoration', {
            account_id: { type: DataTypes.BIGINT, primaryKey: true, allowNull: false },
            last_restore: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false, defaultValue: 0 },
            pending_realm_uid: { type: DataTypes.STRING(36), allowNull: true }, pending_request_id: { type: DataTypes.STRING(36), allowNull: true },
            pending_at: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false, defaultValue: 0 }
        }, { tableName: 'account_restorations', timestamps: false, engine: 'InnoDB' }),
        GameAccountOptions: sequelize.define('GameAccountOptions', {
            game_account_id: { type: DataTypes.BIGINT, primaryKey: true, allowNull: false }, options: { type: DataTypes.JSON, allowNull: false }
        }, { tableName: 'game_account_options', timestamps: false, engine: 'InnoDB' }) };
};
