'use strict';
// Invoked by admin's isolated MariaDB acceptance. Never use a live database.
const fs = require('node:fs');
const assert = require('node:assert/strict');
const Sequelize = require('sequelize');
const { Authenticator, codeAt, metadata, requireProof } = require('../utils/authenticator');

async function main() {
    const config = JSON.parse(fs.readFileSync(process.env.ADMIN_TEST_CONFIG));
    if (!/^skymist_admin_test_[a-f0-9]{12}$/.test(config.database)) { throw new Error('Not an isolated fixture database'); }
    const sql = new Sequelize(config.database, config.user, config.password, {
        host: config.host, port: config.port, dialect: 'mysql', logging: false, dialectOptions: { bigNumberStrings: true }, pool: { max: 4 }
    });
    try {
        const Account = require('../models/account')(sql, Sequelize.DataTypes);
        const account = await Account.findByPk(config.authenticatorAccount);
        const key = Buffer.from(config.authenticatorKey, 'hex'), now = config.authenticatorTime + 30;
        const verifier = new Authenticator({ sequelize: sql, Account }, key, () => now * 1000);
        const pending = { ...metadata(account), expiresAt: now + 120 };
        const code = codeAt(Buffer.from('12345678901234567890'), Math.floor(now / 30));
        const results = await Promise.all([verifier.verify(account, pending, code), verifier.verify(account, pending, code)]);
        assert.equal(results.filter(Boolean).length, 1, 'one concurrent transaction consumes the code');
        const proof = results.find(Boolean);
        requireProof(account, proof, now * 1000);
        assert.equal(await verifier.verify(account, pending, code), null, 'SQL rejects replay');
        await Account.update({ hash: 'changed-fixture-hash' }, { where: { id: account.id } });
        const reset = await Account.findByPk(account.id);
        assert.equal(BigInt(reset.credentialVersion), BigInt(account.credentialVersion) + 1n, 'password trigger bumps credentials');
        assert.throws(() => requireProof(reset, proof, now * 1000));
        assert.equal(await verifier.verify(account, pending, code), null, 'password reset invalidates pending challenge');
        key.fill(0);
    } finally { await sql.close(); }
}
if (require.main === module) {
    main().catch(() => { console.error('Isolated authenticator acceptance failed'); process.exitCode = 1; });
}
