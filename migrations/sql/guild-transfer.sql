-- BGS owns shared guild coordination for this installation. Character data stays in realm schemas.
-- Shared-installation coordination. Heartbeat expiry never grants ownership:
-- the world keeps a dedicated named-lock SQL session for its lifetime.
CREATE TABLE IF NOT EXISTS guild_service_realm (
    realm_id INT UNSIGNED NOT NULL,
    realm_uid CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    namespace VARCHAR(63) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    installation_id CHAR(32) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    database_service_id CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    auth_schema VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    character_schema VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    owner_epoch CHAR(32) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    owner_connection BIGINT UNSIGNED NOT NULL,
    heartbeat BIGINT UNSIGNED NOT NULL,
    protocol_version INT UNSIGNED NOT NULL,
    PRIMARY KEY (realm_id),
    UNIQUE KEY realm_identity (realm_uid),
    UNIQUE KEY distinct_character_schema (installation_id, database_service_id, character_schema)
) ENGINE=InnoDB DEFAULT CHARSET=utf8;

CREATE TABLE IF NOT EXISTS guild_transfer_operation (
    operation_id CHAR(32) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    plan_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL DEFAULT '',
    service VARCHAR(24) CHARACTER SET ascii NOT NULL,
    source_realm INT UNSIGNED NOT NULL,
    destination_realm INT UNSIGNED NOT NULL,
    source_uid CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL DEFAULT '',
    destination_uid CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL DEFAULT '',
    source_schema VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    destination_schema VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    source_guild INT UNSIGNED NOT NULL,
    destination_guild INT UNSIGNED NOT NULL DEFAULT 0,
    leader_guid INT UNSIGNED NOT NULL,
    successor_guid INT UNSIGNED NOT NULL,
    parent_operation CHAR(32) CHARACTER SET ascii COLLATE ascii_bin NOT NULL DEFAULT '',
    new_name VARCHAR(24) NOT NULL,
    new_race TINYINT UNSIGNED NOT NULL DEFAULT 0,
    new_gender TINYINT UNSIGNED NOT NULL DEFAULT 0,
    phase VARCHAR(24) CHARACTER SET ascii NOT NULL,
    source_epoch CHAR(32) CHARACTER SET ascii COLLATE ascii_bin NOT NULL DEFAULT '',
    destination_epoch CHAR(32) CHARACTER SET ascii COLLATE ascii_bin NOT NULL DEFAULT '',
    source_publication_epoch CHAR(32) CHARACTER SET ascii COLLATE ascii_bin NOT NULL DEFAULT '',
    destination_publication_epoch CHAR(32) CHARACTER SET ascii COLLATE ascii_bin NOT NULL DEFAULT '',
    manifest_version INT UNSIGNED NOT NULL DEFAULT 1,
    manifest_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL DEFAULT '',
    created_at BIGINT UNSIGNED NOT NULL,
    committed_at BIGINT UNSIGNED NOT NULL DEFAULT 0,
    completed_at BIGINT UNSIGNED NOT NULL DEFAULT 0,
    PRIMARY KEY (operation_id),
    KEY source_history (source_realm, source_guild, service, committed_at),
    KEY destination_history (destination_realm, destination_guild, service, committed_at),
    KEY recovery_phase (phase, created_at),
    CONSTRAINT guild_transfer_service CHECK (service IN ('realm-transfer','faction-change','follow')),
    CONSTRAINT guild_transfer_phase CHECK (phase IN ('preparing','prepared','fencing','saving','reserving','ready',
        'committed','publishing','complete','cancelled','blocked'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8;

CREATE TABLE IF NOT EXISTS guild_transfer_character (
    operation_id CHAR(32) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    source_guid INT UNSIGNED NOT NULL,
    destination_guid INT UNSIGNED NOT NULL DEFAULT 0,
    account_id INT UNSIGNED NOT NULL,
    game_account_id BIGINT NOT NULL,
    destination_account_id INT UNSIGNED NOT NULL,
    role VARCHAR(16) CHARACTER SET ascii NOT NULL,
    old_name VARCHAR(12) NOT NULL,
    new_name VARCHAR(12) NOT NULL,
    old_race TINYINT UNSIGNED NOT NULL,
    new_race TINYINT UNSIGNED NOT NULL,
    old_gender TINYINT UNSIGNED NOT NULL,
    new_gender TINYINT UNSIGNED NOT NULL,
    total_reputation INT UNSIGNED NOT NULL,
    weekly_reputation INT UNSIGNED NOT NULL,
    reputation_period BIGINT UNSIGNED NOT NULL,
    PRIMARY KEY (operation_id, source_guid),
    CONSTRAINT guild_transfer_character_role CHECK (role IN ('leader','follower'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8;

CREATE TABLE IF NOT EXISTS guild_transfer_identity (
    operation_id CHAR(32) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    entity TINYINT UNSIGNED NOT NULL,
    source_id BIGINT UNSIGNED NOT NULL,
    destination_id BIGINT UNSIGNED DEFAULT NULL,
    provenance_only TINYINT UNSIGNED NOT NULL DEFAULT 0,
    PRIMARY KEY (operation_id, entity, source_id),
    UNIQUE KEY one_destination_identity (operation_id, entity, destination_id),
    CONSTRAINT guild_transfer_identity_kind CHECK (entity BETWEEN 1 AND 10)
) ENGINE=InnoDB DEFAULT CHARSET=utf8;

CREATE TABLE IF NOT EXISTS guild_transfer_manifest (
    operation_id CHAR(32) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    table_name VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    schema_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    row_count BIGINT UNSIGNED NOT NULL,
    source_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    destination_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL DEFAULT '',
    PRIMARY KEY (operation_id, table_name)
) ENGINE=InnoDB DEFAULT CHARSET=utf8;

CREATE TABLE IF NOT EXISTS guild_transfer_step (
    operation_id CHAR(32) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    realm_id INT UNSIGNED NOT NULL,
    action VARCHAR(16) CHARACTER SET ascii NOT NULL,
    state VARCHAR(16) CHARACTER SET ascii NOT NULL DEFAULT 'pending',
    owner_epoch CHAR(32) CHARACTER SET ascii COLLATE ascii_bin NOT NULL DEFAULT '',
    dispatch_source_epoch CHAR(32) CHARACTER SET ascii COLLATE ascii_bin NOT NULL DEFAULT '',
    dispatch_target_epoch CHAR(32) CHARACTER SET ascii COLLATE ascii_bin NOT NULL DEFAULT '',
    dispatch_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL DEFAULT '',
    acknowledged_at BIGINT UNSIGNED NOT NULL DEFAULT 0,
    rejection VARCHAR(255) NOT NULL DEFAULT '',
    PRIMARY KEY (operation_id, realm_id, action),
    KEY pending_world_work (realm_id, state),
    CONSTRAINT guild_transfer_action CHECK (action IN ('catalog','fence','save','reserve','publish','release')),
    CONSTRAINT guild_transfer_mail_state CHECK (state IN ('pending','acknowledged','rejected'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8;

CREATE TABLE IF NOT EXISTS guild_transfer_follow (
    parent_operation CHAR(32) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    source_guid INT UNSIGNED NOT NULL,
    account_id INT UNSIGNED NOT NULL,
    eligible_reputation INT UNSIGNED NOT NULL,
    consumed_operation CHAR(32) CHARACTER SET ascii COLLATE ascii_bin NOT NULL DEFAULT '',
    PRIMARY KEY (parent_operation, source_guid)
) ENGINE=InnoDB DEFAULT CHARSET=utf8;

-- Typed binary row frames preserve the exact pre-transfer state, including
-- records retained as source-realm audit/provenance instead of live gameplay.
CREATE TABLE IF NOT EXISTS guild_transfer_manifest_row (
    operation_id CHAR(32) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    table_name VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    `row_number` BIGINT UNSIGNED NOT NULL,
    payload LONGBLOB NOT NULL,
    payload_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    PRIMARY KEY (operation_id, table_name, `row_number`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8;

-- Catalogs are captured by the destination world owner, never inferred from
-- the source realm's possibly different world database or configuration.
CREATE TABLE IF NOT EXISTS guild_transfer_catalog (
    operation_id CHAR(32) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    source_guid INT UNSIGNED NOT NULL,
    owner_epoch CHAR(32) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    input_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    payload_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    version INT UNSIGNED NOT NULL,
    payload LONGBLOB NOT NULL,
    PRIMARY KEY (operation_id,source_guid)
) ENGINE=InnoDB DEFAULT CHARSET=utf8;

ALTER TABLE guild_transfer_character ADD COLUMN IF NOT EXISTS new_skin TINYINT UNSIGNED NOT NULL DEFAULT 0;
ALTER TABLE guild_transfer_character ADD COLUMN IF NOT EXISTS new_face TINYINT UNSIGNED NOT NULL DEFAULT 0;
ALTER TABLE guild_transfer_character ADD COLUMN IF NOT EXISTS new_hair_style TINYINT UNSIGNED NOT NULL DEFAULT 0;
ALTER TABLE guild_transfer_character ADD COLUMN IF NOT EXISTS new_hair_color TINYINT UNSIGNED NOT NULL DEFAULT 0;
ALTER TABLE guild_transfer_character ADD COLUMN IF NOT EXISTS new_facial_hair TINYINT UNSIGNED NOT NULL DEFAULT 0;

-- An old source GUID may remain an achievement/mail provenance identity after
-- its character becomes playable under a destination alias ID. Track that
-- identity through subsequent moves without minting duplicate contributors.
CREATE TABLE IF NOT EXISTS guild_transfer_character_route (
    origin_realm INT UNSIGNED NOT NULL,
    origin_guid INT UNSIGNED NOT NULL,
    current_realm INT UNSIGNED NOT NULL,
    current_guid INT UNSIGNED NOT NULL,
    account_id BIGINT NOT NULL,
    operation_id CHAR(32) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    PRIMARY KEY (origin_realm,origin_guid),
    KEY current_character (current_realm,current_guid)
) ENGINE=InnoDB DEFAULT CHARSET=utf8;

-- Raw tagged challenge/reputation/activity/withdrawal periods are transferable
-- only between compatible world-owned reset calendars. Zero means unacknowledged.
ALTER TABLE guild_service_realm ADD COLUMN IF NOT EXISTS weekly_anchor BIGINT UNSIGNED NOT NULL DEFAULT 0;
ALTER TABLE guild_service_realm ADD COLUMN IF NOT EXISTS daily_period BIGINT UNSIGNED NOT NULL DEFAULT 0;
ALTER TABLE guild_service_realm ADD COLUMN IF NOT EXISTS next_daily BIGINT UNSIGNED NOT NULL DEFAULT 0;

-- Named locks/connection IDs are local to a database node. A replicated claim
-- changes only after the exact original node/account/session has ended.
ALTER TABLE guild_service_realm ADD COLUMN IF NOT EXISTS owner_member VARCHAR(255) CHARACTER SET ascii COLLATE ascii_bin NOT NULL DEFAULT '';
ALTER TABLE guild_service_realm ADD COLUMN IF NOT EXISTS owner_port INT UNSIGNED NOT NULL DEFAULT 0;
ALTER TABLE guild_service_realm ADD COLUMN IF NOT EXISTS owner_account VARCHAR(288) CHARACTER SET ascii COLLATE ascii_bin NOT NULL DEFAULT '';
ALTER TABLE guild_service_realm ADD COLUMN IF NOT EXISTS owner_endpoint VARCHAR(255) CHARACTER SET ascii COLLATE ascii_bin NOT NULL DEFAULT '';
ALTER TABLE guild_service_realm ADD COLUMN IF NOT EXISTS guard_sequence BIGINT UNSIGNED NOT NULL DEFAULT 0;

-- Immutable reviewed command framing supports recovery without an admin socket
-- or reconstructed defaults. NULL belongs only to pre-v2 incomplete operations.
ALTER TABLE guild_transfer_operation ADD COLUMN IF NOT EXISTS review_payload MEDIUMBLOB DEFAULT NULL;
ALTER TABLE guild_transfer_operation ADD COLUMN IF NOT EXISTS last_error VARCHAR(255) NOT NULL DEFAULT '';

-- Reviewed source-local arena changes, kept as durable publication evidence.
-- These teams remain on the source realm; only the moving actor is detached.
CREATE TABLE IF NOT EXISTS guild_transfer_arena (
    operation_id CHAR(32) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    source_guid INT UNSIGNED NOT NULL,
    team_id INT UNSIGNED NOT NULL,
    successor_guid INT UNSIGNED NOT NULL,
    captain_guid_before INT UNSIGNED NOT NULL,
    PRIMARY KEY (operation_id,source_guid,team_id),
    KEY source_character (source_guid),
    CONSTRAINT guild_transfer_arena_identity CHECK (source_guid>0 AND team_id>0 AND captain_guid_before>0),
    CONSTRAINT guild_transfer_arena_successor CHECK
        ((captain_guid_before=source_guid AND successor_guid>0 AND successor_guid<>source_guid) OR
         (captain_guid_before<>source_guid AND successor_guid=0))
) ENGINE=InnoDB DEFAULT CHARSET=utf8;

ALTER TABLE guild_transfer_operation ADD COLUMN IF NOT EXISTS source_review_epoch CHAR(32) CHARACTER SET ascii COLLATE ascii_bin NOT NULL DEFAULT '';
CREATE TABLE IF NOT EXISTS guild_transfer_plan_member (
    operation_id CHAR(32) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    character_guid INT UNSIGNED NOT NULL,
    interruption_kind TINYINT UNSIGNED NOT NULL,
    PRIMARY KEY(operation_id,character_guid),
    CONSTRAINT guild_transfer_member_kind CHECK(interruption_kind IN(1,2))
) ENGINE=InnoDB DEFAULT CHARSET=utf8;
CREATE TABLE IF NOT EXISTS guild_transfer_guild_slot (
    realm_id INT UNSIGNED NOT NULL,
    guild_id INT UNSIGNED NOT NULL,
    operation_id CHAR(32) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    PRIMARY KEY(realm_id,guild_id),
    KEY operation_slots(operation_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8;

ALTER TABLE guild_transfer_operation ADD COLUMN IF NOT EXISTS cancel_requested TINYINT UNSIGNED NOT NULL DEFAULT 0;

ALTER TABLE guild_service_realm ADD COLUMN IF NOT EXISTS realm_first_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL DEFAULT '';

ALTER TABLE guild_transfer_identity DROP CONSTRAINT IF EXISTS guild_transfer_identity_kind;
ALTER TABLE guild_transfer_identity ADD CONSTRAINT guild_transfer_identity_kind CHECK(entity BETWEEN 1 AND 11);
ALTER TABLE guild_transfer_operation ADD COLUMN IF NOT EXISTS exclusive_manifest_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL DEFAULT '';

ALTER TABLE guild_transfer_operation ALTER COLUMN manifest_version SET DEFAULT 2;

-- A confirmed persistent publication may be delivered more than once. The
-- immutable message identity and the SQL step receipt make replay harmless.
CREATE TABLE IF NOT EXISTS guild_transfer_outbox (
    message_id CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL PRIMARY KEY,
    source_realm INT UNSIGNED NOT NULL,
    payload VARBINARY(2048) NOT NULL,
    published_at BIGINT UNSIGNED NOT NULL DEFAULT 0,
    KEY pending_publisher (source_realm,published_at,message_id)
) ENGINE=InnoDB;
CREATE TABLE IF NOT EXISTS guild_transfer_inbox (
    message_id CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL PRIMARY KEY,
    operation_id CHAR(32) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    realm_id INT UNSIGNED NOT NULL,
    action VARCHAR(16) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    source_epoch CHAR(32) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    target_epoch CHAR(32) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    plan_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    received_at BIGINT UNSIGNED NOT NULL,
    UNIQUE KEY received_step (operation_id,realm_id,action,source_epoch,target_epoch,plan_hash)
) ENGINE=InnoDB;

-- Native relocation and this summary are one cross-schema transaction. BGS
-- publishes both realm summaries exactly once before gameplay fences release.
CREATE TABLE IF NOT EXISTS guild_transfer_publication (
    operation_id CHAR(32) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    realm_id INT UNSIGNED NOT NULL,
    game_account_id BIGINT NOT NULL,
    character_count TINYINT UNSIGNED NOT NULL,
    last_character BIGINT UNSIGNED NULL,
    published_at BIGINT UNSIGNED NOT NULL DEFAULT 0,
    PRIMARY KEY (operation_id, realm_id, game_account_id),
    CONSTRAINT guild_publication_account CHECK (game_account_id > 0)
) ENGINE=InnoDB;
