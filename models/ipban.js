'use strict';
module.exports = (sequelize, DataTypes) => sequelize.define('IPBan', {
    id: { type: DataTypes.BIGINT, primaryKey: true, autoIncrement: true },
    address: { type: DataTypes.STRING(45), allowNull: false, unique: true },
    expiresAt: { type: DataTypes.DATE, field: 'expires_at' },
    reason: { type: DataTypes.STRING(1024), allowNull: false }
}, { tableName: 'ip_bans', timestamps: true, underscored: true });
