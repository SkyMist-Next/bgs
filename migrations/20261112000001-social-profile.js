'use strict';

const KEY = 'battle_tag_case_key';
const INDEX = 'accounts_battle_tag_case_unique';
const EXPRESSION = 'LOWER(CONVERT(battle_tag USING utf8mb4))';

async function preflight(q) {
    // Compare the entire lowercased UTF-8 value as bytes: no accent folding,
    // prefix index, or collation-dependent trailing-space equivalence.
    const key = `CAST(${EXPRESSION} AS BINARY)`;
    const [duplicates] = await q.sequelize.query(`SELECT CAST(a.id AS CHAR) AS id FROM accounts a
        JOIN (SELECT ${key} AS tag_key FROM accounts GROUP BY tag_key HAVING COUNT(*) > 1) duplicates
        ON CAST(LOWER(CONVERT(a.battle_tag USING utf8mb4)) AS BINARY) = duplicates.tag_key ORDER BY a.id`);
    if (duplicates.length) {
        const error = new Error('Case-insensitive full BattleTag collisions; resolve account IDs before migration: ' + JSON.stringify(duplicates));
        error.code = 'BGS_BATTLE_TAG_CONFLICT';
        throw error;
    }
}

module.exports = {
    preflight,
    async up(q, S) {
        // MariaDB DDL commits implicitly; refuse collisions before any DDL.
        await preflight(q);
        const columns = await q.describeTable('accounts');
        // Read raw metadata: Sequelize's MySQL showIndex treats the string '1'
        // as unique when BIGINT string results are enabled for account IDs.
        const [index] = await q.sequelize.query(`SELECT NON_UNIQUE AS non_unique, COLUMN_NAME AS column_name,
            SUB_PART AS prefix_length FROM information_schema.STATISTICS
            WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='accounts' AND INDEX_NAME='${INDEX}' ORDER BY SEQ_IN_INDEX`);
        if (index.length && (index.length !== 1 || Number(index[0].non_unique) !== 0 || index[0].column_name !== KEY || index[0].prefix_length !== null)) {
            throw new Error('Existing BattleTag uniqueness index has an incompatible definition; no indexes were changed');
        }
        if (columns[KEY]) {
            const [rows] = await q.sequelize.query(`SELECT DATA_TYPE AS type, CHARACTER_MAXIMUM_LENGTH AS size,
                GENERATION_EXPRESSION AS expression, EXTRA AS extra FROM information_schema.COLUMNS
                WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='accounts' AND COLUMN_NAME='${KEY}'`);
            const row = rows[0];
            const expression = row && typeof row.expression === 'string' && row.expression.replace(/[`\s]/g, '').toLowerCase().replace(/^lcase\(/, 'lower(');
            if (!row || row.type !== 'varbinary' || Number(row.size) !== 1020 || !row.extra.includes('STORED GENERATED') ||
                expression !== 'lower(convert(battle_tagusingutf8mb4))') {
                throw new Error('Existing BattleTag case key has an incompatible definition; no columns were changed');
            }
        }
        if (!columns.given_name) {
            await q.addColumn('accounts', 'given_name', { type: S.STRING(255), allowNull: true });
        }
        if (!columns.surname) {
            await q.addColumn('accounts', 'surname', { type: S.STRING(255), allowNull: true });
        }
        if (!columns.real_id_enabled) {
            await q.addColumn('accounts', 'real_id_enabled', { type: S.BOOLEAN, allowNull: false, defaultValue: false });
        }
        if (!columns[KEY]) {
            await q.sequelize.query(`ALTER TABLE accounts ADD COLUMN ${KEY} VARBINARY(1020)
                GENERATED ALWAYS AS (${EXPRESSION}) STORED`);
        }
        if (!index.length) {
            await q.addIndex('accounts', [KEY], { name: INDEX, unique: true });
        }
    },
    async down() { throw new Error('Social profile migration is additive; preserve profiles and BattleTag uniqueness on rollback'); }
};
