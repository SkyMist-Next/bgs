'use strict';
const { DataTypes, QueryTypes } = require('sequelize');
const { MAX_INDEX } = require('../utils/wow-license');

module.exports = {
    async up(q) {
        if (!(await q.describeTable('accounts')).wow_license_index_high_water) {
            await q.addColumn('accounts', 'wow_license_index_high_water', { type: DataTypes.INTEGER.UNSIGNED, allowNull: false, defaultValue: 0 });
        }
        if (!(await q.describeTable('game_accounts')).wow_license_index) {
            await q.addColumn('game_accounts', 'wow_license_index', { type: DataTypes.INTEGER.UNSIGNED, allowNull: true });
        }
        await q.sequelize.query(`CREATE TRIGGER IF NOT EXISTS game_accounts_license_insert BEFORE INSERT ON game_accounts FOR EACH ROW
            BEGIN
                IF (NEW.program = 'WoW' AND (NEW.wow_license_index IS NULL OR NEW.wow_license_index = 0 OR
                    NEW.wow_license_index > COALESCE((SELECT wow_license_index_high_water FROM accounts WHERE id=NEW.account_id),0)))
                    OR (NEW.program <> 'WoW' AND NEW.wow_license_index IS NOT NULL) THEN
                    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='Invalid WoW license allocation';
                END IF;
            END`);
        // Backfill one parent at a time under the same row lock used by creators.
        // DDL steps are repeatable after interruption; valid assigned indexes never change.
        let after = '0';
        for (;;) {
            const parents = await q.sequelize.query('SELECT CAST(id AS CHAR) AS id FROM accounts WHERE id > :after ORDER BY id LIMIT 100',
                { replacements: { after }, type: QueryTypes.SELECT });
            if (!parents.length) { break; }
            for (const parent of parents) {
                await q.sequelize.transaction(async transaction => {
                    const options = { replacements: { id: parent.id }, type: QueryTypes.SELECT, transaction };
                    const [row] = await q.sequelize.query('SELECT wow_license_index_high_water AS high FROM accounts WHERE id=:id FOR UPDATE', options);
                    if (!row) { return; }
                    const games = await q.sequelize.query('SELECT CAST(id AS CHAR) AS id,program,wow_license_index AS idx FROM game_accounts WHERE account_id=:id ORDER BY id FOR UPDATE', options);
                    let high = Number(row.high);
                    const seen = new Set();
                    for (const game of games) {
                        if (game.idx === null) { continue; }
                        if (game.program !== 'WoW' || !Number.isInteger(game.idx) || game.idx < 1 || game.idx > MAX_INDEX || seen.has(game.idx)) {
                            throw new Error('Conflicting WoW license identity');
                        }
                        seen.add(game.idx); high = Math.max(high, game.idx);
                    }
                    for (const game of games) {
                        if (game.program !== 'WoW' || game.idx !== null) { continue; }
                        if (high >= MAX_INDEX) { throw new Error('WoW license index exhausted'); }
                        await q.sequelize.query('UPDATE game_accounts SET wow_license_index=:index WHERE id=:game AND wow_license_index IS NULL',
                            { replacements: { index: ++high, game: game.id }, transaction });
                    }
                    await q.sequelize.query('UPDATE accounts SET wow_license_index_high_water=:high WHERE id=:id',
                        { replacements: { high, id: parent.id }, transaction });
                });
                after = parent.id;
            }
        }
        if (!(await q.showIndex('game_accounts')).some(index => index.name === 'game_accounts_wow_license')) {
            await q.addIndex('game_accounts', ['account_id', 'wow_license_index'], { unique: true, name: 'game_accounts_wow_license' });
        }
        // Sequelize cannot express portable immutable-column triggers. These protect
        // DML-only admin/raw writers as well as ORM callers and bulk updates.
        await q.sequelize.query(`CREATE TRIGGER IF NOT EXISTS game_accounts_license_immutable BEFORE UPDATE ON game_accounts FOR EACH ROW
            BEGIN
                IF NOT (NEW.account_id <=> OLD.account_id) OR NOT (NEW.program <=> OLD.program) OR NOT (NEW.wow_license_index <=> OLD.wow_license_index) THEN
                    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='GameAccount license identity is immutable';
                END IF;
            END`);
        await q.sequelize.query(`CREATE TRIGGER IF NOT EXISTS accounts_license_high_water BEFORE UPDATE ON accounts FOR EACH ROW
            BEGIN
                IF NEW.wow_license_index_high_water < OLD.wow_license_index_high_water THEN
                    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='WoW license counter cannot decrease';
                END IF;
            END`);
        const [invalid] = await q.sequelize.query(`SELECT COUNT(*) AS n FROM game_accounts WHERE
            (program='WoW' AND (wow_license_index IS NULL OR wow_license_index=0)) OR
            (program<>'WoW' AND wow_license_index IS NOT NULL)`, { type: QueryTypes.SELECT });
        if (Number(invalid.n)) { throw new Error('WoW license backfill incomplete'); }
    },
    async down() { throw new Error('Persisted WoW license identities cannot be rolled back'); }
};
