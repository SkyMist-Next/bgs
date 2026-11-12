-- Social identity belongs to the parent account, never a license or character.
-- Lock existing accounts in ascending numeric ID order before touching these tables.
-- Account columns match accounts.id (signed BIGINT). Revisions and generated IDs are unsigned.
CREATE TABLE IF NOT EXISTS social_revisions (
    account_id BIGINT NOT NULL PRIMARY KEY,
    revision BIGINT UNSIGNED NOT NULL DEFAULT 0,
    CONSTRAINT social_revision_account FOREIGN KEY (account_id) REFERENCES accounts(id)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS social_friendships (
    low_id BIGINT NOT NULL,
    high_id BIGINT NOT NULL,
    kind VARCHAR(16) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    created_at DATETIME(3) NOT NULL,
    PRIMARY KEY (low_id, high_id),
    KEY social_friend_high (high_id, low_id),
    CONSTRAINT social_friend_low FOREIGN KEY (low_id) REFERENCES accounts(id),
    CONSTRAINT social_friend_high_account FOREIGN KEY (high_id) REFERENCES accounts(id),
    CONSTRAINT social_friend_order CHECK (low_id < high_id),
    CONSTRAINT social_friend_kind CHECK (kind IN ('real_id','battle_tag'))
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS social_invitations (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    low_id BIGINT NOT NULL,
    high_id BIGINT NOT NULL,
    sender_id BIGINT NOT NULL,
    recipient_id BIGINT NOT NULL,
    kind VARCHAR(16) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    message VARCHAR(1024) NOT NULL DEFAULT '',
    created_at DATETIME(3) NOT NULL,
    UNIQUE KEY social_invitation_pair (low_id, high_id),
    KEY social_invitation_sender (sender_id, id),
    KEY social_invitation_recipient (recipient_id, id),
    CONSTRAINT social_invitation_low FOREIGN KEY (low_id) REFERENCES accounts(id),
    CONSTRAINT social_invitation_high FOREIGN KEY (high_id) REFERENCES accounts(id),
    CONSTRAINT social_invitation_order CHECK (low_id < high_id),
    CONSTRAINT social_invitation_direction CHECK
        ((sender_id=low_id AND recipient_id=high_id) OR (sender_id=high_id AND recipient_id=low_id)),
    CONSTRAINT social_invitation_kind CHECK (kind IN ('real_id','battle_tag'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;

CREATE TABLE IF NOT EXISTS social_notes (
    account_id BIGINT NOT NULL,
    friend_id BIGINT NOT NULL,
    note VARCHAR(1024) NOT NULL,
    PRIMARY KEY (account_id, friend_id),
    CONSTRAINT social_note_owner FOREIGN KEY (account_id) REFERENCES accounts(id),
    CONSTRAINT social_note_friend FOREIGN KEY (friend_id) REFERENCES accounts(id),
    CONSTRAINT social_note_distinct CHECK (account_id <> friend_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;

CREATE TABLE IF NOT EXISTS social_blocks (
    account_id BIGINT NOT NULL,
    blocked_id BIGINT NOT NULL,
    created_at DATETIME(3) NOT NULL,
    PRIMARY KEY (account_id, blocked_id),
    KEY social_block_target (blocked_id, account_id),
    CONSTRAINT social_block_owner FOREIGN KEY (account_id) REFERENCES accounts(id),
    CONSTRAINT social_block_peer FOREIGN KEY (blocked_id) REFERENCES accounts(id),
    CONSTRAINT social_block_distinct CHECK (account_id <> blocked_id)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS social_reports (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    reporter_id BIGINT NOT NULL,
    target_id BIGINT NOT NULL,
    reason VARCHAR(64) NOT NULL,
    details TEXT NOT NULL,
    created_at DATETIME(3) NOT NULL,
    KEY social_report_rate (reporter_id, created_at),
    CONSTRAINT social_report_owner FOREIGN KEY (reporter_id) REFERENCES accounts(id),
    CONSTRAINT social_report_target FOREIGN KEY (target_id) REFERENCES accounts(id),
    CONSTRAINT social_report_distinct CHECK (reporter_id <> target_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;

-- Keep successful request receipts until the caller's retry namespace is retired.
-- They are deliberately not expired automatically: an old retry must not recreate a friendship.
CREATE TABLE IF NOT EXISTS social_mutations (
    account_id BIGINT NOT NULL,
    operation_id VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    request_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    result JSON NOT NULL,
    created_at DATETIME(3) NOT NULL,
    PRIMARY KEY (account_id, operation_id),
    CONSTRAINT social_mutation_owner FOREIGN KEY (account_id) REFERENCES accounts(id)
) ENGINE=InnoDB;

-- Payloads are semantic invalidations containing IDs only, never real names or notes.
-- Publishers confirm delivery before acknowledgement. Duplicate delivery is safe by account/revision.
CREATE TABLE IF NOT EXISTS social_outbox (
    account_id BIGINT NOT NULL,
    revision BIGINT UNSIGNED NOT NULL,
    payload JSON NOT NULL,
    created_at DATETIME(3) NOT NULL,
    published_at DATETIME(3) NULL,
    PRIMARY KEY (account_id, revision),
    KEY social_outbox_pending (published_at, created_at, account_id, revision),
    KEY social_outbox_account_pending (account_id, published_at),
    CONSTRAINT social_outbox_owner FOREIGN KEY (account_id) REFERENCES accounts(id)
) ENGINE=InnoDB;
