'use strict';

module.exports = (sequelize, T) => sequelize.define('SocialSessionBlock', {
    id: { type: T.STRING(36), primaryKey: true },
    sessionKey: { type: T.STRING(80), allowNull: false, field: 'session_key' },
    accountId: { type: T.BIGINT, allowNull: false, field: 'account_id' },
    blockedAccountId: { type: T.BIGINT, allowNull: false, field: 'blocked_account_id' },
    route: { type: T.JSON, allowNull: false },
    createdAt: { type: T.DATE(3), allowNull: false, field: 'created_at' }
}, { tableName: 'social_session_blocks', timestamps: false, indexes: [
    { unique: true, fields: ['session_key', 'blocked_account_id'], name: 'social_session_block_identity' },
    { fields: ['account_id'] },
    { fields: ['account_id', 'blocked_account_id'], name: 'social_session_block_parent_target' }
] });
