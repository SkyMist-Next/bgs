'use strict';
module.exports = (sequelize, DataTypes) => sequelize.define('GameAccountPrivilege', {
    gameAccountId: { type: DataTypes.BIGINT, field: 'game_account_id', primaryKey: true },
    realmUid: { type: DataTypes.STRING(36), field: 'realm_uid', primaryKey: true },
    level: { type: DataTypes.TINYINT, allowNull: false },
    updatedAt: { type: DataTypes.DATE, field: 'updated_at', allowNull: false }
}, { tableName: 'game_account_privileges', timestamps: false });
