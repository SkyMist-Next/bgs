'use strict';

// Real ID is on by default (ADR-0001 amendment 2026-11-26): every existing account
// is opted in and new rows default to enabled. Administrators can still opt an
// account out. Accounts without names expose an empty full name, never a guess.
module.exports = {
    async up(q) {
        await q.sequelize.query(
            'ALTER TABLE accounts ALTER COLUMN real_id_enabled SET DEFAULT 1',
        );
        await q.sequelize.query(
            'UPDATE accounts SET real_id_enabled = 1 WHERE real_id_enabled = 0',
        );
    },
    // Restores only the default: individual earlier opt-ins are indistinguishable
    // after up, so existing rows keep their current value.
    async down(q) {
        await q.sequelize.query(
            'ALTER TABLE accounts ALTER COLUMN real_id_enabled SET DEFAULT 0',
        );
    },
};
