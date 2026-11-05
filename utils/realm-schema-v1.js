'use strict';

// Frozen schema definitions for the versioned realm migrations. Add a new
// migration/schema version when changing stored columns; do not edit this shape.
module.exports = function realmSchemaV1(sequelize, D) {
    const key = type => ({ type, allowNull: false, primaryKey: true });
    const required = type => ({ type, allowNull: false });
    const guid = () => D.CHAR(36);
    const define = (name, tableName, attributes) => ({ name, tableName, attributes });
    return {
        RealmRPCOutcome: define('RealmRPCOutcome', 'realm_rpc_outcomes', {
            realm_uid: key(guid()), request_id: key(guid()), fingerprint: required(D.CHAR(64)), response: { type: D.JSON, allowNull: true },
            created_at: { type: D.DATE(6), allowNull: false, defaultValue: sequelize.literal('CURRENT_TIMESTAMP(6)') }
        }),
        GameAccountSession: define('GameAccountSession', 'game_account_sessions', {
            game_account_id: key(D.BIGINT), generation: { ...required(D.BIGINT.UNSIGNED), defaultValue: '0' },
            ...Object.fromEntries(['session_id', 'realm_uid', 'pod_uid', 'instance_id'].map(name => [name, { ...required(guid()), defaultValue: '' }])),
            pending_request_id: { type: guid(), allowNull: true }
        }),
        GameAccountReservation: define('GameAccountReservation', 'game_account_reservations', {
            realm_uid: key(guid()), request_id: key(guid()), game_account_id: required(D.BIGINT), account_id: required(D.BIGINT),
            session_id: required(guid()), generation: required(D.BIGINT.UNSIGNED), pod_uid: required(guid()), instance_id: required(guid()),
            changes: required(D.JSON), status: { ...required(D.ENUM('staging', 'prepared', 'committed', 'aborted')), defaultValue: 'prepared' },
            expected_changes: { ...required(D.INTEGER.UNSIGNED), defaultValue: 0 }, expected_chunks: { ...required(D.INTEGER.UNSIGNED), defaultValue: 0 }
        }),
        GameAccountState: define('GameAccountState', 'game_account_state', {
            game_account_id: key(D.BIGINT), domain: key(D.STRING(32).BINARY), entity_key: key(D.STRING(64).BINARY), revision: required(D.BIGINT.UNSIGNED), value: required(D.JSON)
        }),
        GameAccountCharacters: define('GameAccountCharacters', 'game_account_characters', {
            game_account_id: key(D.BIGINT), realm_uid: key(guid()), character_count: required(D.INTEGER.UNSIGNED), last_character: { type: D.BIGINT.UNSIGNED, allowNull: true }
        }),
        GameAccountPermission: define('GameAccountPermission', 'game_account_permissions', {
            game_account_id: key(D.BIGINT), realm_uid: { ...key(D.STRING(36).BINARY), defaultValue: '' }, permission_id: key(D.INTEGER.UNSIGNED),
            granted: required(D.BOOLEAN), updated_at: required(D.DATE(6))
        }),
        GameAccountReservationChunk: define('GameAccountReservationChunk', 'game_account_reservation_chunks', {
            realm_uid: key(guid()), reservation_id: key(guid()), chunk_index: key(D.INTEGER.UNSIGNED), changes: required(D.JSON)
        }),
        RealmProcessOwner: define('RealmProcessOwner', 'realm_process_owners', {
            realm_uid: key(guid()), instance_id: { ...required(guid()), defaultValue: '' }
        }),
        RealmProcessPermit: define('RealmProcessPermit', 'realm_process_permits', {
            realm_uid: key(guid()), instance_id: key(guid()), pod_uid: required(guid()), revision: required(D.CHAR(64)),
            build: required(D.INTEGER.UNSIGNED), expansion: required(D.TINYINT.UNSIGNED), previous_epoch: required(D.STRING(36)), epoch: required(guid())
        })
    };
};
