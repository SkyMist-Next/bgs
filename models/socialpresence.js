'use strict';

module.exports = (sequelize, T) => ({
    SocialPresenceState: sequelize.define('SocialPresenceState', {
        subject: { type: T.STRING(32), primaryKey: true },
        accountId: { type: T.BIGINT, allowNull: false, field: 'account_id' },
        values: { type: T.JSON, allowNull: false }
    }, { tableName: 'social_presence_state', timestamps: false })
});
