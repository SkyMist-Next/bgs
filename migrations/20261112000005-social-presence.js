'use strict';
module.exports = {
    async up(q, T) {
        await q.createTable('social_presence_state', {
            subject: { type: T.STRING(32), primaryKey: true },
            account_id: { type: T.BIGINT, allowNull: false },
            values: { type: T.JSON, allowNull: false }
        });
    },
    async down(q) { await q.dropTable('social_presence_state'); }
};
