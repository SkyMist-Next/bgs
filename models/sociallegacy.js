'use strict';

module.exports = (sequelize, T) => {
    const define = (name, tableName, attributes, indexes = []) => sequelize.models[name] || sequelize.define(name, attributes, {
        tableName, timestamps: false, underscored: true, engine: 'InnoDB', indexes
    });
    const id = () => ({ type: T.BIGINT, allowNull: false });
    const generation = () => ({ type: T.BIGINT.UNSIGNED, allowNull: false });
    const session = () => ({ type: T.STRING(80), allowNull: false });
    const group = () => ({ type: T.STRING(36), allowNull: false });
    const date = () => ({ type: T.DATE(3), allowNull: false });
    return {
        SocialLegacyOwner: define('SocialLegacyOwner', 'social_legacy_owners', {
            gameAccountId: { ...id(), primaryKey: true }, accountId: id(), sessionKey: session(), generation: generation(),
            route: { type: T.JSON, allowNull: false }, objectId: generation(), active: { type: T.BOOLEAN, allowNull: false }, updatedAt: date()
        }, [{ fields: ['account_id', 'game_account_id'] }]),
        // A previously fenced connection cannot win ownership again by replaying
        // Subscribe. This is session fencing metadata, not chat history.
        SocialLegacyClaim: define('SocialLegacyClaim', 'social_legacy_claims', {
            gameAccountId: { ...id(), primaryKey: true }, sessionKey: { ...session(), primaryKey: true },
            accountId: id(), generation: generation(), route: { type: T.JSON, allowNull: false }, createdAt: date()
        }, [{ fields: ['created_at', 'game_account_id'] }]),
        SocialLegacyGroup: define('SocialLegacyGroup', 'social_legacy_groups', {
            id: { ...group(), primaryKey: true }, createdAt: date()
        }),
        SocialLegacyMember: define('SocialLegacyMember', 'social_legacy_members', {
            groupId: { ...group(), primaryKey: true }, gameAccountId: { ...id(), primaryKey: true }, accountId: id(),
            sessionKey: session(), generation: generation(), joinedAt: date()
        }, [{ fields: ['game_account_id', 'session_key', 'generation', 'group_id'] }]),
        SocialLegacyClosed: define('SocialLegacyClosed', 'social_legacy_closed', {
            groupId: { ...group(), primaryKey: true }, gameAccountId: { ...id(), primaryKey: true }, accountId: id(),
            sessionKey: session(), generation: generation(),
            peerGameAccountId: { type: T.BIGINT, allowNull: true }, peerAccountId: { type: T.BIGINT, allowNull: true }, createdAt: date()
        }, [{ fields: ['game_account_id', 'session_key', 'generation'] }]),
        SocialLegacyMutation: define('SocialLegacyMutation', 'social_legacy_mutations', {
            accountId: { ...id(), primaryKey: true }, operationId: { type: T.CHAR(64), allowNull: false, primaryKey: true },
            requestHash: { type: T.CHAR(64), allowNull: false }, result: { type: T.JSON, allowNull: false }, createdAt: date()
        })
    };
};
