'use strict';

const mysql = require('mysql2/promise');
const bcrypt = require('bcrypt');
const EMAIL = 'bgs-local@example.invalid';
const BATTLE_TAG = 'LocalTest#0001';

// Invoked explicitly through kubectl exec, using the REST Pod's DML-only identity.
async function provision({ email, password }) {
    const url = new URL(process.env.DATABASE_URL);
    if (url.hostname !== 'bgs-test-bgs-db' || url.pathname !== '/bgs' ||
        email !== EMAIL || typeof password !== 'string' || password.length !== 16) {
        throw new Error('Local fixture target or credentials do not match');
    }
    const sql = await mysql.createConnection({
        host: url.hostname, user: decodeURIComponent(url.username), password: decodeURIComponent(url.password),
        database: url.pathname.slice(1), connectTimeout: 5000, supportBigNumbers: true, bigNumberStrings: true
    });
    try {
        const [[lock]] = await sql.execute('SELECT GET_LOCK(?, 10) AS acquired', ['bgs-local-fixture']);
        if (Number(lock.acquired) !== 1) { throw new Error('Local fixture is busy'); }
        await sql.beginTransaction();
        const [accounts] = await sql.execute('SELECT id, hash, battle_tag FROM accounts WHERE email = ? FOR UPDATE', [email]);
        if (accounts.length > 1 || (accounts.length === 1 &&
            (accounts[0].battle_tag !== BATTLE_TAG || !await bcrypt.compare(password, accounts[0].hash)))) {
            throw new Error('Existing local account does not belong to this fixture');
        }
        let accountId = accounts[0]?.id;
        if (!accountId) {
            await sql.execute('INSERT INTO accounts (email, hash, battle_tag, created_at, updated_at) VALUES (?, ?, ?, NOW(), NOW())',
                [email, await bcrypt.hash(password, 10), BATTLE_TAG]);
            const [[created]] = await sql.query('SELECT CAST(LAST_INSERT_ID() AS CHAR) AS id');
            accountId = created.id;
        }
        const [games] = await sql.execute('SELECT id, program, region, display_name FROM game_accounts WHERE account_id = ? FOR UPDATE', [accountId]);
        if (games.length > 1 || (games.length === 1 &&
            (games[0].program !== 'WoW' || games[0].region !== 3 || games[0].display_name !== 'WoW Local'))) {
            throw new Error('Existing game accounts do not match the local fixture');
        }
        let gameAccountId = games[0]?.id;
        if (!gameAccountId) {
            const [[parent]] = await sql.execute('SELECT wow_license_index_high_water AS high FROM accounts WHERE id=? FOR UPDATE', [accountId]);
            if (!Number.isInteger(parent.high) || parent.high < 0 || parent.high >= 0xFFFFFFFF) { throw new Error('WoW license index exhausted'); }
            await sql.execute('UPDATE accounts SET wow_license_index_high_water=? WHERE id=?', [parent.high + 1, accountId]);
            await sql.execute('INSERT INTO game_accounts (account_id, program, region, display_name, wow_license_index, created_at, updated_at) VALUES (?, ?, ?, ?, ?, NOW(), NOW())',
                [accountId, 'WoW', 3, 'WoW Local', parent.high + 1]);
            const [[created]] = await sql.query('SELECT CAST(LAST_INSERT_ID() AS CHAR) AS id');
            gameAccountId = created.id;
        }
        await sql.commit();
        const [migrations] = await sql.query('SELECT name FROM SequelizeMeta ORDER BY name');
        const [incomplete] = await sql.query('SELECT name FROM BgsMigrationJournal WHERE complete = FALSE');
        if (incomplete.length) { throw new Error('Incomplete migration journal'); }
        return { accountId: String(accountId), gameAccountId: String(gameAccountId), migrations: migrations.map(row => row.name) };
    }
    finally { await sql.end(); } // Disconnect releases the advisory lock and rolls back any failed transaction.
}

async function main() {
    let input = '';
    for await (const chunk of process.stdin) {
        input += chunk;
        if (input.length > 4096) { throw new Error('Fixture input too large'); }
    }
    console.log(JSON.stringify(await provision(JSON.parse(input))));
}
if (require.main === module) {
    main().catch(() => { console.error('Local fixture provisioning failed; account data was not replaced.'); process.exitCode = 1; });
}
module.exports = { provision, EMAIL };
