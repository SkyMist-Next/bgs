'use strict';

module.exports = function defineSocialGraph(sequelize, D) {
    const account = () => ({ type: D.BIGINT, allowNull: false });
    const key = () => ({ ...account(), primaryKey: true });
    const serial = () => ({ type: D.BIGINT.UNSIGNED, primaryKey: true, autoIncrement: true });
    const kind = () => ({ type: D.STRING(16), allowNull: false, validate: { isIn: [['real_id', 'battle_tag']] } });
    const date = () => ({ type: D.DATE(3), allowNull: false });
    const define = (name, tableName, attributes, indexes = []) => sequelize.models[name] || sequelize.define(name, attributes, {
        tableName, timestamps: false, underscored: true, engine: 'InnoDB', indexes
    });
    return {
        SocialRevision: define('SocialRevision', 'social_revisions', {
            accountId: key(), revision: { type: D.BIGINT.UNSIGNED, allowNull: false, defaultValue: '0' }
        }),
        SocialFriendship: define('SocialFriendship', 'social_friendships', {
            lowId: key(), highId: key(), kind: kind(), createdAt: date()
        }, [{ fields: ['high_id', 'low_id'] }]),
        SocialInvitation: define('SocialInvitation', 'social_invitations', {
            id: serial(), lowId: account(), highId: account(), senderId: account(), recipientId: account(), kind: kind(),
            message: { type: D.STRING(1024), allowNull: false, defaultValue: '' }, createdAt: date()
        }, [{ unique: true, fields: ['low_id', 'high_id'] }, { fields: ['sender_id', 'id'] }, { fields: ['recipient_id', 'id'] }]),
        SocialNote: define('SocialNote', 'social_notes', {
            accountId: key(), friendId: key(), note: { type: D.STRING(1024), allowNull: false }
        }),
        SocialBlock: define('SocialBlock', 'social_blocks', {
            accountId: key(), blockedId: key(), createdAt: date()
        }, [{ fields: ['blocked_id', 'account_id'] }]),
        SocialReport: define('SocialReport', 'social_reports', {
            id: serial(), reporterId: account(), targetId: account(), reason: { type: D.STRING(64), allowNull: false },
            details: { type: D.TEXT, allowNull: false }, createdAt: date()
        }, [{ fields: ['reporter_id', 'created_at'] }]),
        SocialMutation: define('SocialMutation', 'social_mutations', {
            accountId: key(), operationId: { type: D.STRING(64), allowNull: false, primaryKey: true },
            requestHash: { type: D.CHAR(64), allowNull: false }, result: { type: D.JSON, allowNull: false }, createdAt: date()
        }),
        SocialOutbox: define('SocialOutbox', 'social_outbox', {
            accountId: key(), revision: { type: D.BIGINT.UNSIGNED, primaryKey: true, allowNull: false },
            payload: { type: D.JSON, allowNull: false }, createdAt: date(), publishedAt: { type: D.DATE(3), allowNull: true }
        }, [{ fields: ['published_at', 'created_at', 'account_id', 'revision'] }, { fields: ['account_id', 'published_at'] }])
    };
};
