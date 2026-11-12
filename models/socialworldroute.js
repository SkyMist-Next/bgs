'use strict';

module.exports = (sequelize, T) => sequelize.define('SocialWorldRoute', {
    id: { type: T.STRING(36), primaryKey: true },
    sessionKey: { type: T.STRING(80), allowNull: false, field: 'session_key' },
    accountId: { type: T.BIGINT, allowNull: false, field: 'account_id' },
    gameAccountId: { type: T.BIGINT, allowNull: false, field: 'game_account_id' },
    routeEpoch: { type: T.BIGINT.UNSIGNED, allowNull: false, field: 'route_epoch' },
    route: { type: T.JSON, allowNull: false }
}, { tableName: 'social_world_routes', timestamps: false, indexes: [
    { unique: true, fields: ['session_key'], name: 'social_world_route_session' },
    { fields: ['account_id'] }
] });
