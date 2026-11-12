'use strict';

module.exports = (sequelize, T) => ({
    SocialWorldRoute: require('./socialworldroute')(sequelize, T),
    SocialSessionBlock: require('./socialsessionblock')(sequelize, T),
    SocialSubscription: sequelize.define('SocialSubscription', {
        id: { type: T.STRING(36), primaryKey: true },
        sessionKey: { type: T.STRING(80), allowNull: false, field: 'session_key' },
        accountId: { type: T.BIGINT, allowNull: false, field: 'account_id' },
        gameAccountId: { type: T.BIGINT, allowNull: true, field: 'game_account_id' },
        kind: { type: T.STRING(32), allowNull: false },
        target: { type: T.STRING(64), allowNull: false },
        objectId: { type: T.BIGINT.UNSIGNED, allowNull: false, field: 'object_id' },
        route: { type: T.JSON, allowNull: false },
        filter: { type: T.JSON, allowNull: false },
        snapshot: { type: T.JSON, allowNull: true },
        ready: { type: T.BOOLEAN, allowNull: false, defaultValue: false },
        expiresAt: { type: T.DATE, allowNull: false, field: 'expires_at' }
    }, { tableName: 'social_subscriptions', timestamps: false, indexes: [
        { unique: true, fields: ['session_key', 'kind', 'target', 'object_id'] },
        { fields: ['kind', 'id'] }, { fields: ['account_id', 'kind'] }, { fields: ['expires_at'] }
    ] })
});
